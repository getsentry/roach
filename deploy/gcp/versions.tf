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
  # The state holds the CA key and the write token. It is in a private
  # bucket of the project. Another deployment changes the bucket here.
  backend "gcs" {
    bucket = "roach-511216-tfstate-dc-k4m9v2qx"
    prefix = "roach"
  }
}

provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}
