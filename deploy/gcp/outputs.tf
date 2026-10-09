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

output "tenant_tokens" {
  description = "The write token of each tenant. Keep each one in a CI secret of its project, such as ROACH_TOKEN."
  value       = { for name, token in random_password.tenant : name => token.result }
  sensitive   = true
}
