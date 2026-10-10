# The production deployment of Roach for Sentry. Apply with:
#   terraform init && terraform apply -var-file=roach.tfvars
# This file holds no secrets. Terraform makes the CA key and the write token,
# and keeps them only in the state bucket (see versions.tf).
project = "roach-511216"
# Point an A record of this name at the ip_address output.
domain = "roach-proxy.sentry.dev"

# The origins of Junior's evals (packages/junior-evals/src/recording-rules.ts).
allow = [
  "https://ai-gateway.vercel.sh",
  "https://vercel.com",
  "https://api.vercel.com",
  "https://oidc.vercel.com",
  "https://docs.slack.dev",
]

# Junior's own value patterns, in addition to the built-in ones.
value_patterns = [
  "(?<![\\w-])(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\\d{1,2}(?:, \\d{4}, \\d{1,2}:\\d{2}\\s?[AP]M| \\d{2}:\\d{2})\\b",
  "(?<=event_id=)[0-9a-f]{32}(?![0-9A-Za-z])",
]

# To send metrics to Sentry, set TF_VAR_sentry_dsn when you apply.
