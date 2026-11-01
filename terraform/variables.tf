variable "coolify_endpoint" {
  description = "Base URL of your Coolify instance, e.g. https://coolify.example.com"
  type        = string
}

variable "coolify_token" {
  description = "Coolify API token. Needs root or read:sensitive permission so the database connection URL can be read."
  type        = string
  sensitive   = true
}

variable "server_uuid" {
  description = "UUID of the Coolify server to deploy on (Servers page in the Coolify UI; 'localhost' server if Coolify runs on the same machine)."
  type        = string
}

variable "project_name" {
  description = "Name of the Coolify project."
  type        = string
  default     = "cinetra"
}

variable "environment_name" {
  description = "Coolify environment inside the project."
  type        = string
  default     = "production"
}

variable "git_repository" {
  description = "Public Git repository to build from."
  type        = string
  default     = "https://github.com/an-nyx/cinetra"
}

variable "git_branch" {
  description = "Branch to deploy."
  type        = string
  default     = "main"
}

variable "domain" {
  description = "Public URL for the app, including scheme, e.g. https://cinetra.example.com. Coolify's proxy issues the TLS certificate."
  type        = string
}

variable "app_port" {
  description = "Port the Node.js app listens on inside the container."
  type        = number
  default     = 3000
}

variable "postgres_image" {
  description = "PostgreSQL image. Keep the major version in sync with the data you restore."
  type        = string
  default     = "postgres:18"
}

variable "postgres_user" {
  type    = string
  default = "cinetra"
}

variable "postgres_db" {
  type    = string
  default = "cinetra"
}

variable "api_authorization" {
  description = "TMDB API authorization header value, e.g. 'Bearer <token>'."
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT signing secret. Set it to your current secret to keep existing sessions valid; leave null to generate one."
  type        = string
  sensitive   = true
  default     = null
}
