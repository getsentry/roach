terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.4"
    }
  }
  # The state holds the CA key and the write token. Keep it in a private
  # bucket, for example:
  # backend "gcs" {
  #   bucket = "my-terraform-state"
  #   prefix = "roach"
  # }
}

provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}
