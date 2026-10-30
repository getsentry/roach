# The production deployment of Roach for Sentry. Apply with:
#   terraform init && terraform apply -var-file=roach.tfvars
# This file holds no secrets. Terraform makes the CA key and the write token,
# and keeps them only in the state bucket (see versions.tf).
project = "roach-511216"
# Point an A record of this name at the ip_address output.
# The record is in getsentry/ops (getsentry/ops#24232).
domain = "roach-proxy.getsentry.net"

# The Deploy workflow of this repository resets the VM (deploy.tf).
deploy_repository    = "getsentry/roach"
deploy_repository_id = "1412275249"

# Runs send their own origins and value patterns (RunConfig in src/service.ts),
# so a tenant needs no change here.

# The service sends metrics and spans to the sentry/roach project.
# A DSN only lets a client send events, so it is not a secret.
sentry_dsn = "https://68127ffce4e8fa6bdc3270d3c7570821@o1.ingest.us.sentry.io/4512346152763392"
