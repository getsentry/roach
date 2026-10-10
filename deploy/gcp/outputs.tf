output "ip_address" {
  description = "Point an A record of the domain at this address. The TLS certificate starts to work some minutes after DNS does."
  value       = google_compute_global_address.roach.address
}

output "url" {
  description = "The URL of the service. Clients give it to startRemoteRun()."
  value       = "https://${var.domain}"
}

output "ca_cert" {
  description = "The certificate that clients trust. The service also serves it at /__roach/ca.pem, and each run returns it."
  value       = tls_self_signed_cert.ca.cert_pem
}

output "write_token" {
  description = "The write token of all tenants. Keep it in one organization secret, ROACH_TOKEN, for the repositories that you trust."
  value       = random_password.write_token.result
  sensitive   = true
}
