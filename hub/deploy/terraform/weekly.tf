# Weekly team briefs (execution WBS 4.3): every Monday morning Cloud Scheduler calls POST /internal/weekly with a
# Google-signed OIDC token for its own service account, and the hub accepts that one account and nothing else
# (HUB_SCHEDULER_SA, src/auth/scheduler.ts). The account gets no role on the project, the database or the key: the hub
# does the work with its own identity. Without the job the hub still works — the first reader of last week's brief
# generates it — so set weekly_schedule = "" where Cloud Scheduler is not wanted or not offered in the region.

locals { weekly = var.weekly_schedule != "" }

resource "google_service_account" "scheduler" {
  count        = local.weekly ? 1 : 0
  account_id   = "${var.service_name}-weekly"
  display_name = "PP WBS Hub weekly scheduler"
}

resource "google_cloud_scheduler_job" "weekly" {
  count            = local.weekly ? 1 : 0
  name             = "${var.service_name}-weekly"
  region           = var.region
  description      = "Last week's brief for every team; weeks older than half a year removed. Idempotent."
  schedule         = var.weekly_schedule
  time_zone        = var.weekly_time_zone
  attempt_deadline = "300s"
  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "600s"
  }
  http_target {
    http_method = "POST"
    uri         = "${var.public_url}/internal/weekly"
    oidc_token {
      service_account_email = google_service_account.scheduler[0].email
      audience              = "${var.public_url}/internal/weekly"
    }
  }
  depends_on = [google_cloud_run_v2_service.hub]
}
