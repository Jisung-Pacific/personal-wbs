#!/usr/bin/env bash
# One-time setup of the PP WBS Hub inside an existing Firebase project. Run it as the project's owner in Cloud Shell
# (gcloud, terraform, docker, curl and python3 are already there), from a clone of this repository:
#
#   git clone -b v0.2 https://github.com/Jisung-Pacific/personal-wbs && cd personal-wbs/hub
#   PROJECT=my-project bash deploy/bootstrap.sh
#
# Everything else has a default it works out by itself; set a variable only to override it.
#   REGION            asia-northeast3
#   PUBLIC_URL        the service's own address, https://ppwbs-hub-<project number>.<region>.run.app. It becomes the OAuth
#                     issuer: set your own domain here only once that domain already reaches the service (deploy/cloudflare),
#                     because changing it later signs every connected agent out.
#   FIREBASE_WEB      the project's web app config, from the Firebase Management API (FIREBASE_WEB_APP_ID picks the app
#                     when the project has several)
#   AUTH_PROVIDERS    the sign-in providers the project has switched on, from the Identity Platform admin API
#                     (e.g. google,oidc.kakao=Kakao,password)
#   GITHUB_REPOSITORY, GITHUB_REF   this clone's origin and branch, so later pushes deploy themselves
#                     (GITHUB_REPOSITORY=none → no CI deployer)
#   TF_STATE_BUCKET   <project>-ppwbs-hub-tfstate, versioned; Terraform state lives there, not in this clone
# Optional: HOST_NAME, HOST_SESSION_URL, HOST_AUTH=google-oidc, HOST_AUDIENCE, HOST_CHANNEL, HOST_TERMS_URL,
#   HOST_PRIVACY_URL, HOST_REQUIRED=1, HOST_APPCHECK_APP_ID, BRAND, CHECK_REVOKED=0, SUPPORT_EMAIL,
#   PROXY=1 (a secret shared with a reverse proxy on your own domain), PLAN_ONLY=1 (create nothing: print the plan, stop),
#   BUILD=cloud (build the image in Cloud Build when this shell cannot push to Artifact Registry).
#
# It creates only new resources (deploy/terraform) and waits for your "yes" before every apply. After it, pushes to
# GITHUB_REF roll new images by themselves (.github/workflows/hub-deploy.yml); run it again only to change infrastructure.
set -euo pipefail
cd "$(dirname "$0")/.."                                    # hub/
SERVICE=ppwbs-hub
TF=deploy/terraform
PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null)}
: "${PROJECT:?set PROJECT}"
REGION=${REGION:-asia-northeast3}
gcloud config set project "$PROJECT" >/dev/null
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
PUBLIC_URL=${PUBLIC_URL:-https://$SERVICE-$NUMBER.$REGION.run.app}
PUBLIC_URL=${PUBLIC_URL%/}
PUBLIC_HOST=${PUBLIC_URL#https://}; PUBLIC_HOST=${PUBLIC_HOST%%/*}
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$SERVICE/hub"
BUCKET=${TF_STATE_BUCKET:-$PROJECT-$SERVICE-tfstate}
say() { printf '\n== %s\n' "$*"; }
api() {   # GET a Google API as you (the owner), billed to this project
  curl -fsS -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $PROJECT" "$1"
}
have_docker() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }
latest_version() {   # newest enabled version number of a secret, or nothing
  gcloud secrets versions list "$1" --filter=state=ENABLED --sort-by=~createTime --limit=1 --format='value(name)' --quiet 2>/dev/null | sed 's#.*/##' || true
}

say "project $PROJECT ($NUMBER) · region $REGION · as $(gcloud config get-value account 2>/dev/null)"
echo "issuer (PUBLIC_URL): $PUBLIC_URL"

# ---- the project's Firebase web config: the same app its own web front end signs in with
if [ -z "${FIREBASE_WEB:-}" ]; then
  APP=${FIREBASE_WEB_APP_ID:-}
  if [ -z "$APP" ]; then
    APP=$(api "https://firebase.googleapis.com/v1beta1/projects/$PROJECT/webApps?pageSize=100" | python3 -c '
import json, sys
apps = [a for a in json.load(sys.stdin).get("apps", []) if a.get("state", "ACTIVE") == "ACTIVE"]
if len(apps) == 1:
    print(apps[0]["appId"]); sys.exit(0)
for a in apps:
    print("  " + a["appId"] + "  " + a.get("displayName", ""), file=sys.stderr)
sys.exit("%d web apps in this project: rerun with FIREBASE_WEB_APP_ID=<one of the above>" % len(apps))')
  fi
  FIREBASE_WEB=$(api "https://firebase.googleapis.com/v1beta1/projects/$PROJECT/webApps/$APP/config" | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(json.dumps({"apiKey": c["apiKey"], "authDomain": c.get("authDomain") or c["projectId"] + ".firebaseapp.com", "projectId": c["projectId"]}))')
fi
echo "Firebase web config: $FIREBASE_WEB"

# ---- the sign-in providers the project has switched on, in the order the consent page shows them
if [ -z "${AUTH_PROVIDERS:-}" ]; then
  IDP="https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT"
  AUTH_PROVIDERS=$(DEF=$(api "$IDP/defaultSupportedIdpConfigs" || echo '{}') OIDC=$(api "$IDP/oauthIdpConfigs" || echo '{}') \
    CONF=$(api "$IDP/config" || echo '{}') python3 -c '
import json, os
d, o, c = (json.loads(os.environ[k] or "{}") for k in ("DEF", "OIDC", "CONF"))
on = {x["name"].rsplit("/", 1)[1] for x in d.get("defaultSupportedIdpConfigs", []) if x.get("enabled")}
out = ["google"] if "google.com" in on else []
for x in o.get("oauthIdpConfigs", []):
    if x.get("enabled"):
        pid = x["name"].rsplit("/", 1)[1]
        out.append(pid + "=" + (x.get("displayName") or pid[5:]).replace(",", " ").replace("=", " ").strip())
if "apple.com" in on:
    out.append("apple")
if c.get("signIn", {}).get("email", {}).get("enabled"):
    out.append("password")
print(",".join(out) or "google,password")')
fi
echo "sign-in providers: $AUTH_PROVIDERS"

# ---- continuous deploys from this clone's GitHub repository and branch
if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  GITHUB_REPOSITORY=$(git remote get-url origin 2>/dev/null | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##; s#/$##' || true)
  printf '%s' "$GITHUB_REPOSITORY" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || GITHUB_REPOSITORY=
fi
[ "$GITHUB_REPOSITORY" = none ] && GITHUB_REPOSITORY=
GITHUB_REF=${GITHUB_REF:-refs/heads/$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}
[ -n "$GITHUB_REPOSITORY" ] && echo "deploys from: $GITHUB_REPOSITORY $GITHUB_REF"

say "variables ($TF/hub.auto.tfvars, ignored by git)"
PROJECT=$PROJECT REGION=$REGION PUBLIC_URL=$PUBLIC_URL FIREBASE_WEB=$FIREBASE_WEB AUTH_PROVIDERS=$AUTH_PROVIDERS \
GITHUB_REPOSITORY=$GITHUB_REPOSITORY GITHUB_REF=$GITHUB_REF python3 - "$TF/hub.auto.tfvars" <<'PY'
import json, os, sys
e = os.environ.get
v = {
  'project_id': e('PROJECT'), 'region': e('REGION'), 'public_url': e('PUBLIC_URL'),
  'firebase_web': json.loads(e('FIREBASE_WEB')), 'brand': e('BRAND') or e('HOST_NAME') or 'PP WBS',
  'auth_providers': e('AUTH_PROVIDERS', ''),
  'host_name': e('HOST_NAME', ''), 'host_session_url': e('HOST_SESSION_URL', ''), 'host_auth': e('HOST_AUTH', ''),
  'host_audience': e('HOST_AUDIENCE', ''), 'host_channel': e('HOST_CHANNEL', ''),
  'host_terms_url': e('HOST_TERMS_URL', ''), 'host_privacy_url': e('HOST_PRIVACY_URL', ''),
  'host_appcheck_app_id': e('HOST_APPCHECK_APP_ID', ''), 'host_required': e('HOST_REQUIRED') == '1',
  'check_revoked': e('CHECK_REVOKED', '1') != '0', 'support_email': e('SUPPORT_EMAIL', ''),
  'github_repository': e('GITHUB_REPOSITORY', ''), 'github_ref': e('GITHUB_REF', 'refs/heads/main'),
}
def hcl(x):
    if isinstance(x, bool): return 'true' if x else 'false'
    if isinstance(x, dict): return '{ ' + ', '.join(f'{k} = {hcl(w)}' for k, w in x.items()) + ' }'
    return json.dumps(x, ensure_ascii=False)
open(sys.argv[1], 'w', encoding='utf-8').write(''.join(f'{k} = {hcl(x)}\n' for k, x in v.items()))
print(open(sys.argv[1], encoding='utf-8').read(), end='')
PY

init_state() {   # Terraform state in a versioned bucket of this project (created on the first real run)
  printf 'terraform {\n  backend "gcs" {}\n}\n' > "$TF/_backend.tf"
  ( cd "$TF"
    if [ -f terraform.tfstate ]; then
      terraform init -input=false -backend-config="bucket=$BUCKET" -backend-config="prefix=$SERVICE" -migrate-state -force-copy
    else
      terraform init -input=false -reconfigure -backend-config="bucket=$BUCKET" -backend-config="prefix=$SERVICE"
    fi )
}

if [ "${PLAN_ONLY:-}" = 1 ]; then
  say "plan only: nothing is created or changed"
  if gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then init_state; else rm -f "$TF/_backend.tf"; (cd "$TF" && terraform init -input=false >/dev/null); fi
  SV=$(latest_version "$SERVICE-signing-jwk")
  (cd "$TF" && terraform plan -input=false -var image="$IMAGE@sha256:$(printf '0%.0s' {1..64})" \
    -var signing_jwk_version="${SV:-1}" -var proxy_secret_version="$(latest_version "$SERVICE-proxy-secret")")
  exit 0
fi

say "APIs"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com \
  cloudkms.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com firebaserules.googleapis.com \
  firebaseappcheck.googleapis.com firebase.googleapis.com identitytoolkit.googleapis.com storage.googleapis.com

say "Terraform state: gs://$BUCKET"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://$BUCKET" --versioning
fi
init_state

say "step 1/4: image registry, KMS key, secrets, image builder — review the plan, then type yes"
(cd "$TF" && terraform apply -var image=none -var signing_jwk_version=0 \
  -target=google_artifact_registry_repository.hub -target=google_kms_crypto_key.account_keys \
  -target=google_secret_manager_secret.signing_jwk -target=google_secret_manager_secret.proxy \
  -target=google_storage_bucket_iam_member.builder_reads_source -target=google_artifact_registry_repository_iam_member.builder_push \
  -target=google_project_iam_member.builder_logs)

say "step 2/4: first image"
TAG="$IMAGE:bootstrap-$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
build_in_cloud() {   # Cloud Build under the hub's own builder account (created in step 1)
  local cfg log i; cfg=$(mktemp --suffix=.json); log=$(mktemp)
  printf '{"steps":[{"name":"gcr.io/cloud-builders/docker","args":["build","--platform=linux/amd64","-t","%s","."]}],"images":["%s"],"serviceAccount":"projects/%s/serviceAccounts/%s-builder@%s.iam.gserviceaccount.com","options":{"logging":"CLOUD_LOGGING_ONLY"},"timeout":"1200s"}' \
    "$TAG" "$TAG" "$PROJECT" "$SERVICE" "$PROJECT" > "$cfg"
  for i in 1 2 3 4 5 6; do   # a builder account created moments ago can take a few minutes to reach Cloud Build
    if gcloud builds submit . --config="$cfg" --gcs-source-staging-dir="gs://$PROJECT-$SERVICE-build/source" 2>&1 | tee "$log"; then break; fi
    if [ "$i" -lt 6 ] && grep -q "Unknown service account" "$log"; then echo "builder account not visible to Cloud Build yet ($i/6); retrying in 30s"; sleep 30; continue; fi
    rm -f "$cfg" "$log"; return 1
  done
  rm -f "$cfg" "$log"
  REF="$IMAGE@$(gcloud artifacts docker images describe "$TAG" --format='value(image_summary.digest)')"
}
PUSHED=
if have_docker; then
  docker build -t "$TAG" .   # the local copy also makes the signing key in step 3
  if [ "${BUILD:-}" != cloud ]; then   # BUILD=cloud: this shell cannot reach the registry, go straight to Cloud Build
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
    for i in 1 2; do
      if docker push "$TAG"; then PUSHED=1; break; fi
      echo "push failed ($i/2)"; [ "$i" = 2 ] || sleep 10
    done
    [ -n "$PUSHED" ] && REF=$(docker inspect --format='{{index .RepoDigests 0}}' "$TAG")
  fi
fi
if [ -z "$PUSHED" ]; then
  echo "building in Cloud Build (account $SERVICE-builder)"
  build_in_cloud
fi
echo "image: $REF"

say "step 3/4: keys (only the ones that do not exist yet)"
if [ -z "$(latest_version "$SERVICE-signing-jwk")" ]; then
  if have_docker; then docker run --rm "$TAG" node dist/scripts/new-key.js
  else npm ci --silent && npm run -s build && node dist/scripts/new-key.js; fi | gcloud secrets versions add "$SERVICE-signing-jwk" --data-file=-
fi
if [ "${PROXY:-}" = 1 ] && [ -z "$(latest_version "$SERVICE-proxy-secret")" ]; then
  python3 -c 'import secrets; print(secrets.token_urlsafe(48), end="")' | gcloud secrets versions add "$SERVICE-proxy-secret" --data-file=-
fi
VER=$(latest_version "$SERVICE-signing-jwk")
PROXY_VER=$(latest_version "$SERVICE-proxy-secret")

say "step 4/4: database, rules, service account, the service — review the plan, then type yes"
(cd "$TF" && terraform apply -var image="$REF" -var signing_jwk_version="$VER" -var proxy_secret_version="$PROXY_VER")

say "check"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null "$PUBLIC_URL/.well-known/oauth-authorization-server"; then echo "OK: $PUBLIC_URL answers"; break; fi
  sleep 6
done

cat <<TXT

Connector address (Claude, ChatGPT, Grok, Le Chat, Cursor …): $PUBLIC_URL/mcp
Before the first sign-in, Firebase console → Authentication → Settings → Authorized domains: add
  $PUBLIC_HOST
  (if the project keeps that list in Terraform, add it there as well, or the project's next apply removes it)
TXT
if [ -n "$GITHUB_REPOSITORY" ]; then   # continuous deploys: six repository variables for the keyless workflow
  CMDS=$(python3 -c '
import json, shlex, sys
v = json.loads(sys.argv[1] or "null")
for k, x in (v or {}).items():
    print("gh variable set %s -R %s --body %s" % (k, sys.argv[2], shlex.quote(x)))' "$(cd "$TF" && terraform output -json ci_variables)" "$GITHUB_REPOSITORY")
  if [ -n "$CMDS" ] && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    say "GitHub variables for continuous deploys ($GITHUB_REPOSITORY)"; eval "$CMDS" && echo "set: pushes to $GITHUB_REF now deploy themselves"
  elif [ -n "$CMDS" ]; then
    echo
    echo "For continuous deploys run these once (after: gh auth login), or enter them in GitHub → Settings → Secrets and variables → Actions → Variables:"
    echo "$CMDS"
  fi
fi
if [ -n "$PROXY_VER" ]; then
  echo
  echo "Proxy secret for the Worker on your domain: gcloud secrets versions access $PROXY_VER --secret=$SERVICE-proxy-secret"
fi
