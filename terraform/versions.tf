terraform {
  required_version = ">= 1.6"

  required_providers {
    coolify = {
      source  = "coolify-terraform/coolify"
      version = "~> 0.1.29"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Endpoint and token can also come from the COOLIFY_ENDPOINT / COOLIFY_TOKEN env vars.
provider "coolify" {
  endpoint = var.coolify_endpoint
  token    = var.coolify_token
}
