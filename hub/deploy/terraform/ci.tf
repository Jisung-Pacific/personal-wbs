# Continuous deployment from GitHub Actions without keys: Workload Identity Federation lets only the named repository's
# workflow, on the named ref, act as a deployer that may roll new images of this one service and push to its image repo.
# It cannot change IAM, secrets, the database or the KMS key; those stay with Terraform and its operator.
locals { ci = var.github_repository != "" }

resource "google_artifact_registry_repository" "hub" {
  location      = var.region
  repository_id = var.service_name
  format        = "DOCKER"
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = local.ci ? 1 : 0
  workload_identity_pool_id = "${var.service_name}-github"
  display_name              = "PP WBS Hub CI"
}
resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = local.ci ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref == '${var.github_ref}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  count        = local.ci ? 1 : 0
  account_id   = "${var.service_account_id}-deployer"
  display_name = "PP WBS Hub CI deployer"
}
resource "google_service_account_iam_member" "deployer_from_github" {
  count              = local.ci ? 1 : 0
  service_account_id = google_service_account.deployer[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repository}"
}
resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  count      = local.ci ? 1 : 0
  location   = var.region
  repository = google_artifact_registry_repository.hub.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer[0].email}"
}
resource "google_cloud_run_v2_service_iam_member" "deployer_rolls" {
  count    = local.ci ? 1 : 0
  name     = google_cloud_run_v2_service.hub.name
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer[0].email}"
}
resource "google_service_account_iam_member" "deployer_acts_as_runtime" {   # a new revision runs as the hub's own identity
  count              = local.ci ? 1 : 0
  service_account_id = google_service_account.hub.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer[0].email}"
}

# ---- first-image fallback: Cloud Build under the hub's own builder account, for when pushing from the operator's
# shell is not possible. Never the project's default build account nor another service's.
resource "google_service_account" "builder" {
  account_id   = "${var.service_account_id}-builder"
  display_name = "PP WBS Hub image builder"
}
resource "google_storage_bucket" "build" {   # build sources only; deleted after a week
  name                        = "${var.project_id}-${var.service_name}-build"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "Delete"
    }
  }
}
resource "google_storage_bucket_iam_member" "builder_reads_source" {
  bucket = google_storage_bucket.build.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.builder.email}"
}
resource "google_artifact_registry_repository_iam_member" "builder_push" {
  location   = var.region
  repository = google_artifact_registry_repository.hub.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.builder.email}"
}
resource "google_project_iam_member" "builder_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.builder.email}"
}

output "ci_variables" {
  value = local.ci ? {
    GCP_WIF_PROVIDER = google_iam_workload_identity_pool_provider.github[0].name
    GCP_DEPLOYER_SA  = google_service_account.deployer[0].email
    GCP_REGION       = var.region
    GCP_PROJECT      = var.project_id
    HUB_SERVICE      = var.service_name
    HUB_IMAGE_REPO   = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.hub.repository_id}/hub"
  } : null
}
