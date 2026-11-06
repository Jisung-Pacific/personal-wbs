#!/usr/bin/env bash
# One-time setup of the PP WBS Hub inside an existing Firebase project. Run by the project's owner in Cloud Shell
# (it has gcloud, terraform and node), from a clone of this repository:
#
#   git clone -b v0.2 https://github.com/Jisung-Pacific/personal-wbs && cd personal-wbs/hub
#   PROJECT=my-project REGION=asia-northeast3 PUBLIC_URL=https://wbs.example.com \
#   FIREBASE_WEB='{"apiKey":"…","authDomain":"…","projectId":"…"}' \
#   HOST_NAME=… HOST_SESSION_URL=https://api.example.com/v1/auth/session HOST_TERMS_URL=… HOST_PRIVACY_URL=… \
#   GITHUB_REPOSITORY=owner/repo GITHUB_REF=refs/heads/v0.2 \
#   bash deploy/bootstrap.sh
#
# It creates only new resources (see deploy/terraform/main.tf and ci.tf) and shows every Terraform plan before applying.
# After it, pushes to GITHUB_REF deploy new images on their own (.github/workflows/hub-deploy.yml); run it again only to
# change infrastructure. Optional: HOST_APPCHECK_APP_ID, HOST_REQUIRED=1, BRAND, CHECK_REVOKED=0.
set -euo pipefail
: "${PROJECT:?set PROJECT}" "${REGION:?set REGION}" "${PUBLIC_URL:?set PUBLIC_URL (https)}" "${FIREBASE_WEB:?set FIREBASE_WEB (public Firebase web config JSON)}"
cd "$(dirname "$0")/.."                                    # hub/
TF=deploy/terraform SERVICE=ppwbs-hub
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$SERVICE/hub"

gcloud config set project "$PROJECT" >/dev/null
echo "== APIs"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com \
  cloudkms.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com firebaserules.googleapis.com \
  firebaseappcheck.googleapis.com

echo "== variables ($TF/hub.auto.tfvars, ignored by git)"
python3 - "$TF/hub.auto.tfvars" <<'PY'
import json, os, sys
v = {
  'project_id': os.environ['PROJECT'], 'region': os.environ['REGION'], 'public_url': os.environ['PUBLIC_URL'].rstrip('/'),
  'firebase_web': json.loads(os.environ['FIREBASE_WEB']), 'brand': os.environ.get('BRAND', os.environ.get('HOST_NAME', 'PP WBS')),
  'host_name': os.environ.get('HOST_NAME', ''), 'host_session_url': os.environ.get('HOST_SESSION_URL', ''),
  'host_terms_url': os.environ.get('HOST_TERMS_URL', ''), 'host_privacy_url': os.environ.get('HOST_PRIVACY_URL', ''),
  'host_appcheck_app_id': os.environ.get('HOST_APPCHECK_APP_ID', ''), 'host_required': os.environ.get('HOST_REQUIRED') == '1',
  'check_revoked': os.environ.get('CHECK_REVOKED', '1') != '0',
  'github_repository': os.environ.get('GITHUB_REPOSITORY', ''), 'github_ref': os.environ.get('GITHUB_REF', 'refs/heads/main'),
}
def hcl(x):
    if isinstance(x, bool): return 'true' if x else 'false'
    if isinstance(x, dict): return '{ ' + ', '.join(f'{k} = {hcl(w)}' for k, w in x.items()) + ' }'
    return json.dumps(x)
open(sys.argv[1], 'w').write(''.join(f'{k} = {hcl(x)}\n' for k, x in v.items()))
PY

cd "$TF"
terraform init -input=false
echo "== step 1: image registry, KMS key, signing-key secret"
terraform apply -input=false -var image=none -var signing_jwk_version=0 \
  -target=google_artifact_registry_repository.hub -target=google_kms_crypto_key.account_keys -target=google_secret_manager_secret.signing_jwk
cd - >/dev/null

echo "== step 2: first image"
gcloud builds submit . --tag "$IMAGE:bootstrap"
DIGEST=$(gcloud artifacts docker images describe "$IMAGE:bootstrap" --format='value(image_summary.digest)')

echo "== step 3: signing key (only when none exists yet)"
if ! gcloud secrets versions list "$SERVICE-signing-jwk" --filter=state=ENABLED --limit=1 --format='value(name)' | grep -q .; then
  npm ci && npm run build && node dist/scripts/new-key.js | gcloud secrets versions add "$SERVICE-signing-jwk" --data-file=-
fi
VER=$(gcloud secrets versions list "$SERVICE-signing-jwk" --filter=state=ENABLED --sort-by=~createTime --limit=1 --format='value(name)')

echo "== step 4: everything else (review the plan)"
cd "$TF"
terraform apply -input=false -var image="$IMAGE@$DIGEST" -var signing_jwk_version="$VER"
echo
echo "Service URL: $(terraform output -raw service_url)"
echo "Set these as GitHub repository variables (Settings → Secrets and variables → Actions → Variables) for continuous deploys:"
terraform output -json ci_variables
cat <<'TXT'

Then, in the Firebase console of this project:
  1. Authentication → Settings → Authorized domains: add the host name of PUBLIC_URL.
  2. If the domain is your own: map it to the service (Cloud Run domain mapping, a load balancer, or your CDN) and keep
     PUBLIC_URL exactly as the issuer — changing it later signs every connected agent out.
TXT
