output "project_uuid" {
  value = coolify_project.cinetra.uuid
}

output "application_uuid" {
  description = "Set this as the COOLIFY_APP_UUID GitHub secret."
  value       = coolify_application.app.uuid
}

output "database_uuid" {
  description = "Also the Postgres container name on the server."
  value       = coolify_database_postgresql.db.uuid
}

output "app_url" {
  value = var.domain
}
