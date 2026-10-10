# Roach on GCP: one VM behind a TLS load balancer, with the recordings in a
# GCS bucket. See "Deploy" in README.md.
#
#   client --TLS--> load balancer (Google-managed certificate)
#          --TCP--> VM: Roach container on port 8080 --> upstream APIs
#                                                    --> GCS bucket

locals {
  port = 8080
  # Load balancer proxies and health checks come from these ranges.
  google_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  # Identity-Aware Proxy, for `gcloud compute ssh --tunnel-through-iap`.
  iap_range = "35.235.240.0/20"
}

resource "google_project_service" "apis" {
  for_each           = toset(["compute.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}

# Recordings. Each one is deleted `recording_days` after it was written.
resource "google_storage_bucket" "recordings" {
  name                        = "${var.project}-roach-recordings"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Recordings are a cache. Delete them for good.
  soft_delete_policy {
    retention_duration_seconds = 0
  }
  lifecycle_rule {
    condition {
      age = var.recording_days
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.apis]
}

# The certificate authority that signs intercepted hosts. Clients trust its
# certificate (the ca_cert output), so it must not change on a restart.
resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 24 * 365 * 10
  allowed_uses          = ["cert_signing", "crl_signing"]
  subject {
    common_name  = "Roach CA"
    organization = "Roach"
  }
}

# The write token. All tenants share it, so a new project needs no change
# here. A run without it can only replay. To change it:
#   terraform apply -replace=random_password.write_token
resource "random_password" "write_token" {
  length  = 48
  special = false
}

# The service config (`RoachServiceConfig` in src/service.ts). The VM reads
# it at each start.
resource "google_secret_manager_secret" "config" {
  secret_id = "roach-config"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "config" {
  secret = google_secret_manager_secret.config.id
  secret_data = jsonencode(merge(
    {
      host           = "0.0.0.0"
      port           = local.port
      publicUrl      = "https://${var.domain}"
      bucket         = google_storage_bucket.recordings.name
      allow          = var.allow
      writeTokenHash = sha256(random_password.write_token.result)
      valuePatterns  = var.value_patterns
      ca = {
        cert = tls_self_signed_cert.ca.cert_pem
        key  = tls_private_key.ca.private_key_pem
      }
    },
    var.sentry_dsn == "" ? {} : { sentryDsn = var.sentry_dsn },
  ))
}

resource "google_service_account" "roach" {
  account_id   = "roach-proxy"
  display_name = "Roach"
}

resource "google_storage_bucket_iam_member" "roach" {
  bucket = google_storage_bucket.recordings.name
  role   = "roles/storage.objectUser"
  member = google_service_account.roach.member
}

resource "google_secret_manager_secret_iam_member" "roach" {
  secret_id = google_secret_manager_secret.config.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.roach.member
}

resource "google_compute_network" "roach" {
  name                    = "roach"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "roach" {
  name          = "roach"
  network       = google_compute_network.roach.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

resource "google_compute_firewall" "proxy" {
  name          = "roach-proxy"
  network       = google_compute_network.roach.id
  source_ranges = local.google_ranges
  target_tags   = ["roach"]
  allow {
    protocol = "tcp"
    ports    = [tostring(local.port)]
  }
}

resource "google_compute_firewall" "ssh" {
  name          = "roach-ssh"
  network       = google_compute_network.roach.id
  source_ranges = [local.iap_range]
  target_tags   = ["roach"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_instance" "roach" {
  name         = "roach"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["roach"]
  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 20
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.roach.id
    # An external IP for calls to upstream APIs. The firewall only lets the
    # load balancer and IAP in.
    access_config {}
  }
  service_account {
    email  = google_service_account.roach.email
    scopes = ["cloud-platform"]
  }
  shielded_instance_config {
    enable_secure_boot = true
  }
  metadata = {
    user-data = templatefile("${path.module}/cloud-init.yaml", {
      image   = var.image
      project = var.project
      port    = local.port
      secret  = google_secret_manager_secret.config.secret_id
    })
    google-logging-enabled = "true"
    block-project-ssh-keys = "true"
    enable-oslogin         = "TRUE"
  }
  allow_stopping_for_update = true
  depends_on = [
    google_secret_manager_secret_iam_member.roach,
    google_secret_manager_secret_version.config,
    google_storage_bucket_iam_member.roach,
  ]
}

resource "google_compute_instance_group" "roach" {
  name      = "roach"
  zone      = var.zone
  instances = [google_compute_instance.roach.self_link]
  named_port {
    name = "roach"
    port = local.port
  }
}

resource "google_compute_health_check" "roach" {
  name = "roach"
  tcp_health_check {
    port = local.port
  }
}

resource "google_compute_backend_service" "roach" {
  name                  = "roach"
  protocol              = "TCP"
  port_name             = "roach"
  load_balancing_scheme = "EXTERNAL"
  # A tunnel can be idle while a model thinks.
  timeout_sec   = 3600
  health_checks = [google_compute_health_check.roach.id]
  backend {
    group = google_compute_instance_group.roach.self_link
  }
}

resource "google_compute_managed_ssl_certificate" "roach" {
  name = "roach"
  managed {
    domains = [var.domain]
  }
}

resource "google_compute_target_ssl_proxy" "roach" {
  name             = "roach"
  backend_service  = google_compute_backend_service.roach.id
  ssl_certificates = [google_compute_managed_ssl_certificate.roach.id]
}

resource "google_compute_global_address" "roach" {
  name = "roach"
}

resource "google_compute_global_forwarding_rule" "roach" {
  name                  = "roach"
  target                = google_compute_target_ssl_proxy.roach.id
  ip_address            = google_compute_global_address.roach.address
  port_range            = "443"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL"
}
