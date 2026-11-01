resource "coolify_project" "cinetra" {
  name        = var.project_name
  description = "Managed by Terraform"
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

resource "random_password" "postgres" {
  length  = 32
  special = false # keeps the connection URL free of characters that need escaping
}

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "coolify_database_postgresql" "db" {
  name             = "${var.project_name}-postgres"
  project_uuid     = coolify_project.cinetra.uuid
  server_uuid      = var.server_uuid
  environment_name = var.environment_name

  image             = var.postgres_image
  postgres_user     = var.postgres_user
  postgres_password = random_password.postgres.result
  postgres_db       = var.postgres_db

  # Only reachable from containers on the Coolify network, unlike the old
  # compose setup which published 5432 on the host.
  is_public      = false
  instant_deploy = true
}

# ---------------------------------------------------------------------------
# Application (frontend + backend, built from the repo's dockerfile)
# ---------------------------------------------------------------------------

resource "coolify_application" "app" {
  name             = var.project_name
  project_uuid     = coolify_project.cinetra.uuid
  server_uuid      = var.server_uuid
  environment_name = var.environment_name

  git_repository      = var.git_repository
  git_branch          = var.git_branch
  build_pack          = "dockerfile"
  base_directory      = "/"
  dockerfile_location = "/dockerfile"
  ports_exposes       = tostring(var.app_port)
  domains             = var.domain

  # Env vars are created after the app, so the first deploy is triggered by
  # coolify_deployment.app below instead of instant_deploy.
  instant_deploy = false
}

locals {
  # NODE_ENV must stay runtime-only: at build time it would make
  # `pnpm install` skip devDependencies (typescript) and break `pnpm build`.
  runtime_env = {
    PORT              = tostring(var.app_port)
    NODE_ENV          = "production"
    JWT_SECRET        = coalesce(var.jwt_secret, random_password.jwt_secret.result)
    API_AUTHORIZATION = var.api_authorization
    DATABASE_URL      = coolify_database_postgresql.db.internal_db_url
  }
}

resource "coolify_environment_variable" "app" {
  # Keys are not secret; only the values are. nonsensitive() on the key set
  # lets Terraform use them as for_each keys.
  for_each = nonsensitive(toset(keys(local.runtime_env)))

  application_uuid = coolify_application.app.uuid
  key              = each.key
  value            = local.runtime_env[each.key]
  is_build         = false
  is_runtime       = true
  is_preview       = false
  is_literal       = true
}

# First deployment, once the database and env vars exist. Later deploys on
# push are triggered from GitHub Actions (.github/workflows/deploy.yml).
# Change the trigger (or run `terraform apply -replace=coolify_deployment.app`)
# to force a redeploy from Terraform, e.g. after changing env vars.
resource "coolify_deployment" "app" {
  application_uuid    = coolify_application.app.uuid
  wait_for_completion = true

  triggers = {
    # Hash of all env values: editing any value redeploys. The hash itself is safe to show.
    env = nonsensitive(sha256(jsonencode({ for k, v in coolify_environment_variable.app : k => v.value })))
  }

  timeouts = {
    create = "30m"
  }

  depends_on = [
    coolify_database_postgresql.db,
    coolify_environment_variable.app,
  ]
}
