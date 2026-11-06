# PP WBS Hub inside an existing Firebase project (it shares that project's Firebase Auth users).
# Creates only new resources and grants only new, narrowly scoped bindings; it never touches the project's (default)
# database, its rules, its services or its Identity Platform settings. Review `terraform plan` before every apply.
#
#   - a separate Firestore database (default id "ppwbs") with delete protection, PITR and TTL on short-lived OAuth state
#   - deny-all Security Rules on that database: only the hub's server identity reaches it
#   - a dedicated service account: datastore.user on that one database (IAM condition), its signing-key secret,
#     and optionally firebaseauth.viewer so sign-in can check revoked or disabled accounts
#   - a Cloud KMS key that wraps every account's data key (envelope encryption, src/crypto/envelope.ts); the runtime may
#     encrypt and decrypt with that one key and nothing else, and the key cannot be destroyed by a plan
#   - the Cloud Run service (public: MCP clients and OAuth redirects must reach it), min 0 instances; CI (ci.tf) rolls new
#     images, so Terraform ignores the image after the first apply

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = ">= 6.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  db_name = "projects/${var.project_id}/databases/${var.database_id}"
  sa      = "serviceAccount:${google_service_account.hub.email}"
}

resource "google_firestore_database" "hub" {
  name                              = var.database_id
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "PESSIMISTIC"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  deletion_policy                   = "ABANDON"
}

# expired OAuth requests, codes and refresh tokens disappear on their own (field `expire`)
resource "google_firestore_field" "ttl" {
  for_each   = toset(["oauth_requests", "oauth_codes", "oauth_refresh", "inbox"])   # inbox: processed items, 30 days after
  database   = google_firestore_database.hub.name
  collection = each.key
  field      = "expire"
  ttl_config {}
}

# no client SDK access at all; the hub's service account bypasses rules through IAM
resource "google_firebaserules_ruleset" "hub" {
  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/../firestore.rules")
    }
  }
  depends_on = [google_firestore_database.hub]
}
resource "google_firebaserules_release" "hub" {
  name         = "cloud.firestore/${var.database_id}"   # release name of a named database; confirm in the plan
  ruleset_name = google_firebaserules_ruleset.hub.name
}

resource "google_service_account" "hub" {
  account_id   = var.service_account_id
  display_name = "PP WBS Hub runtime"
}

resource "google_project_iam_member" "datastore_hub_db_only" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = local.sa
  condition {
    title      = "ppwbs-hub-database-only"
    expression = "resource.name == \"${local.db_name}\" || resource.name.startsWith(\"${local.db_name}/\")"
  }
}

resource "google_project_iam_member" "auth_viewer" {
  count   = var.check_revoked ? 1 : 0   # firebaseauth.users.get for checkRevoked; skip if the project reserves it
  project = var.project_id
  role    = "roles/firebaseauth.viewer"
  member  = local.sa
}

# ---- envelope encryption: one KMS key wraps the per-account data keys; 90-day rotation, old versions keep decrypting
resource "google_kms_key_ring" "hub" {
  name     = var.service_name
  location = var.region
}
resource "google_kms_crypto_key" "account_keys" {
  name            = "account-data-keys"
  key_ring        = google_kms_key_ring.hub.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s"
  lifecycle {
    prevent_destroy = true   # destroying it would make every account's ledger unreadable
  }
}
resource "google_kms_crypto_key_iam_member" "hub_wraps" {
  crypto_key_id = google_kms_crypto_key.account_keys.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.sa
}

# ---- host product membership with App Check: the hub signs its own App Check custom tokens (signBlob on itself)
resource "google_service_account_iam_member" "hub_signs_appcheck" {
  count              = var.host_appcheck_app_id != "" ? 1 : 0
  service_account_id = google_service_account.hub.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.sa
}

resource "google_secret_manager_secret" "signing_jwk" {
  secret_id = "${var.service_name}-signing-jwk"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_iam_member" "signing_jwk" {
  secret_id = google_secret_manager_secret.signing_jwk.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.sa
}

# shared with a reverse proxy on your own domain (deploy/cloudflare); empty until bootstrap runs with PROXY=1
resource "google_secret_manager_secret" "proxy" {
  secret_id = "${var.service_name}-proxy-secret"
  replication {
    auto {}
  }
}
resource "google_secret_manager_secret_iam_member" "proxy" {
  secret_id = google_secret_manager_secret.proxy.id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.sa
}

resource "google_cloud_run_v2_service" "hub" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account = google_service_account.hub.email
    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }
    containers {
      image = var.image   # an immutable digest: …@sha256:…
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      env {
        name  = "HUB_STORE"
        value = "firestore"
      }
      env {
        name  = "HUB_PUBLIC_URL"
        value = var.public_url
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "HUB_FIRESTORE_DB"
        value = var.database_id
      }
      env {
        name  = "HUB_FIREBASE_WEB"
        value = jsonencode(var.firebase_web)
      }
      env {
        name  = "HUB_BRAND"
        value = var.brand
      }
      env {
        name  = "HUB_CHECK_REVOKED"
        value = var.check_revoked ? "1" : "0"
      }
      env {
        name  = "HUB_EXTRA_SCOPES"
        value = jsonencode(var.extra_scopes)
      }
      env {
        name  = "HUB_KMS_KEY"
        value = google_kms_crypto_key.account_keys.id
      }
      dynamic "env" {
        for_each = { for k, v in {
          HUB_HOST_NAME            = var.host_name
          HUB_HOST_SESSION_URL     = var.host_session_url
          HUB_HOST_TERMS_URL       = var.host_terms_url
          HUB_HOST_PRIVACY_URL     = var.host_privacy_url
          HUB_HOST_APPCHECK_APP_ID = var.host_appcheck_app_id
          HUB_HOST_REQUIRED        = var.host_required ? "1" : ""
          HUB_HOST_AUTH            = var.host_auth
          HUB_HOST_AUDIENCE        = var.host_audience
          HUB_HOST_CHANNEL         = var.host_channel
          HUB_AUTH_PROVIDERS       = var.auth_providers
          HUB_SUPPORT_EMAIL        = var.support_email
          HUB_OPENAI_APPS_CHALLENGE = var.openai_apps_challenge
        } : k => v if v != "" }
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.proxy_secret_version != "" ? [var.proxy_secret_version] : []
        content {
          name = "HUB_PROXY_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.proxy.secret_id
              version = env.value
            }
          }
        }
      }
      env {
        name = "HUB_SIGNING_JWK"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.signing_jwk.secret_id
            version = var.signing_jwk_version   # a number, never "latest"
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.signing_jwk, google_secret_manager_secret_iam_member.proxy, google_project_iam_member.datastore_hub_db_only, google_kms_crypto_key_iam_member.hub_wraps]
  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]   # CI deploys new images (ci.tf)
  }
}

# MCP clients (Claude, ChatGPT, Gemini…) and OAuth redirects come from the internet; every route checks its own token
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.hub.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "service_url" { value = google_cloud_run_v2_service.hub.uri }
output "service_account" { value = google_service_account.hub.email }
output "kms_key" { value = google_kms_crypto_key.account_keys.id }
