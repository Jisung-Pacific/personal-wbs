variable "project_id" {
  type        = string
  description = "The Firebase project whose Auth users the hub shares."
}
variable "region" {
  type        = string
  description = "Region for the database and the service, e.g. asia-northeast3. A Firestore location cannot change later."
}
variable "database_id" {
  type    = string
  default = "ppwbs"
}
variable "service_name" {
  type    = string
  default = "ppwbs-hub"
}
variable "service_account_id" {
  type    = string
  default = "ppwbs-hub"
}
variable "image" {
  type        = string
  description = "Container image by digest (REGION-docker.pkg.dev/PROJECT/REPO/ppwbs-hub@sha256:…)."
}
variable "public_url" {
  type        = string
  description = "https URL the hub is reached at (custom domain or the run.app URL); the OAuth issuer."
}
variable "firebase_web" {
  type        = object({ apiKey = string, authDomain = string, projectId = string })
  description = "The project's public Firebase web config, used by the sign-in page."
}
variable "brand" {
  type    = string
  default = "PP WBS"
}
variable "extra_scopes" {
  type        = map(object({ ko = string, en = string }))
  default     = {}
  description = "Scopes of services plugged in behind the same accounts; reserved until their tools ship."
}
variable "check_revoked" {
  type    = bool
  default = true
}
variable "signing_jwk_version" {
  type        = string
  description = "Secret Manager version number of the signing key (add one with scripts/new-key)."
}
variable "max_instances" {
  type    = number
  default = 3
}
variable "host_name" {
  type        = string
  default     = ""
  description = "The host product whose members the hub's accounts are (consent page); empty → the brand."
}
variable "host_session_url" {
  type        = string
  default     = ""
  description = "The host's session endpoint (POST {identityToken, timezone, locale}); creates the member on first sign-in. Empty → no membership step."
}
variable "host_terms_url" {
  type    = string
  default = ""
}
variable "host_privacy_url" {
  type    = string
  default = ""
}
variable "host_appcheck_app_id" {
  type        = string
  default     = ""
  description = "The hub's Firebase app id in the host project, when the host enforces App Check (custom provider)."
}
variable "host_required" {
  type    = bool
  default = false
}
variable "host_auth" {
  type        = string
  default     = ""
  description = "google-oidc → the join call carries a Google ID token (the host API is a private Cloud Run service that lets this hub's service account invoke it)."
}
variable "host_audience" {
  type        = string
  default     = ""
  description = "Audience of that ID token; empty → the origin of host_session_url."
}
variable "host_channel" {
  type        = string
  default     = ""
  description = "Sent as `channel` with the join call, so the host can count members who came through the hub."
}
variable "auth_providers" {
  type        = string
  default     = ""
  description = "Sign-in choices on the consent page, in order: google, apple, password, oidc.<id>[=Label]. Empty → google,password."
}
variable "proxy_secret_version" {
  type        = string
  default     = ""
  description = "Secret Manager version of the secret shared with a reverse proxy on your own domain (rate limiting by the real caller). Empty → none."
}
variable "support_email" {
  type    = string
  default = ""
}
variable "openai_apps_challenge" {
  type        = string
  default     = ""
  description = "Domain-verification token from OpenAI's plugin submission portal."
}
variable "github_repository" {
  type        = string
  default     = ""
  description = "owner/repo whose workflow may deploy new images (ci.tf). Empty → no CI deployer."
}
variable "github_ref" {
  type    = string
  default = "refs/heads/main"
}
