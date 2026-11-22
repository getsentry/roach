variable "project" {
  description = "The GCP project of Roach."
  type        = string
}

variable "region" {
  description = "The region of the VM and the bucket. us-east1 is near the GitHub-hosted runners."
  type        = string
  default     = "us-east1"
}

variable "zone" {
  description = "The zone of the VM."
  type        = string
  default     = "us-east1-b"
}

variable "domain" {
  description = "The DNS name of the service, such as roach.example.com. Point an A record at the ip_address output."
  type        = string
}

variable "image" {
  description = "The container image of Roach. The VM pulls it each time the service starts. The Deploy workflow moves `:main` to each green commit of main."
  type        = string
  default     = "ghcr.io/getsentry/roach:main"
}

variable "deploy_repository" {
  description = "The GitHub repository, as owner/repo, whose Deploy workflow on main can reset the VM."
  type        = string
}

variable "deploy_repository_id" {
  description = "The numeric id of deploy_repository: `gh api repos/<owner>/<repo> --jq .id`."
  type        = string
}

# Not a shared-core type (e2-micro, e2-small, e2-medium). Those sustain only
# part of a vCPU, and the proxy uses CPU for each request. When many CI runs
# use Roach at the same time, a shared core runs out of burst, and every
# request gets about 10 times slower.
variable "machine_type" {
  description = "The machine type of the VM."
  type        = string
  default     = "e2-standard-2"
}

variable "recording_days" {
  description = "GCS deletes each recording this many days after it was written."
  type        = number
  default     = 30
}

variable "sentry_dsn" {
  description = "The Sentry DSN of the service. Without one, the service sends nothing to Sentry."
  type        = string
  default     = ""
  sensitive   = true
}
