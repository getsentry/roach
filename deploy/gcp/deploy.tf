# Access for the Deploy workflow (.github/workflows/deploy.yml). GitHub
# Actions gets a short-lived token through workload identity federation, so
# no key is stored in GitHub. Only the Deploy workflow on the main branch of
# `deploy_repository` can get it, and it can only reset the VM.

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  # The repository id does not change when a repository is renamed or
  # deleted and made again.
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.deploy_repository_id}'",
    "assertion.workflow_ref == '${var.deploy_repository}/.github/workflows/deploy.yml@refs/heads/main'",
  ])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deploy" {
  account_id   = "roach-deploy"
  display_name = "Roach deploy (GitHub Actions)"
}

resource "google_service_account_iam_member" "deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.deploy_repository}"
}

# A reset restarts the service, and the service pulls the image again.
resource "google_project_iam_custom_role" "deploy_instance" {
  role_id     = "roachDeployInstance"
  title       = "Roach deploy: reset the VM"
  permissions = ["compute.instances.get", "compute.instances.reset"]
}

resource "google_compute_instance_iam_member" "deploy" {
  instance_name = google_compute_instance.roach.name
  zone          = var.zone
  role          = google_project_iam_custom_role.deploy_instance.id
  member        = google_service_account.deploy.member
}

# `gcloud compute instances reset` waits for the zone operation of the reset.
resource "google_project_iam_custom_role" "deploy_operations" {
  role_id     = "roachDeployOperations"
  title       = "Roach deploy: read zone operations"
  permissions = ["compute.zoneOperations.get"]
}

resource "google_project_iam_member" "deploy_operations" {
  project = var.project
  role    = google_project_iam_custom_role.deploy_operations.id
  member  = google_service_account.deploy.member
}
