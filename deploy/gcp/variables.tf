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

variable "machine_type" {
  description = "The machine type of the VM."
  type        = string
  default     = "e2-small"
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
