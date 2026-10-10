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
  description = "The container image of Roach. The VM pulls it each time the service starts."
  type        = string
  default     = "ghcr.io/getsentry/roach:main"
}

variable "machine_type" {
  description = "The machine type of the VM."
  type        = string
  default     = "e2-small"
}

variable "allow" {
  description = "The only origins that runs can reach, such as https://ai-gateway.vercel.sh."
  type        = list(string)
}

variable "value_patterns" {
  description = "Regular expression sources that rules can use in values, in addition to the built-in ones. Check each one for slow backtracking."
  type        = list(string)
  default     = []
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
