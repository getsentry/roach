# The production deployment of Roach for Sentry. Apply with:
#   terraform init && terraform apply -var-file=roach.tfvars
# This file holds no secrets. Terraform makes the CA key and the write token,
# and keeps them only in the state bucket (see versions.tf).
project = "roach-511216"
# Point an A record of this name at the ip_address output.
# The record is in getsentry/ops (getsentry/ops#24232).
domain = "roach-proxy.getsentry.net"

# Runs send their own origins and value patterns (RunConfig in src/service.ts),
# so a tenant needs no change here.

# To send metrics to Sentry, set TF_VAR_sentry_dsn when you apply.
