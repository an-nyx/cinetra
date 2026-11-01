# Deploying Cinetra on Coolify with Terraform

This folder sets up the whole stack on Coolify:

| Resource | What it is |
|---|---|
| `coolify_project.cinetra` | The Coolify project |
| `coolify_database_postgresql.db` | Postgres 18, private to the Coolify network |
| `coolify_application.app` | The app, built from the repo's `dockerfile` (frontend + backend in one image) |
| `coolify_environment_variable.app` | Runtime env vars (`DATABASE_URL` is wired to the database automatically) |
| `coolify_deployment.app` | The first deployment, after the env vars exist |

Prisma migrations run when the container starts (`dockerfile` CMD), so there is no separate migrate service.

## 1. Prepare Coolify

1. **Settings → Configuration**: enable the API.
2. **Keys & Tokens → API tokens**: create a token with `root` permission (or `read:sensitive` + `write` + `deploy`). Terraform needs `read:sensitive` to read the database connection URL.
3. **Servers**: open your server and copy its UUID (from the URL or the page).
4. Point your domain's DNS record at the server.

## 2. Apply

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill it in
terraform init
terraform apply
```

The apply waits for the first build to finish (up to 30 min).

State is stored locally in `terraform.tfstate`. It contains the database password and other secrets, so keep it safe and out of git (it's already in `.gitignore`).

## 3. Auto-deploy on push

`.github/workflows/deploy.yml` calls the Coolify deploy API on every push to `main`. Add these repository secrets:

| Secret | Value |
|---|---|
| `COOLIFY_URL` | Same as `coolify_endpoint` |
| `COOLIFY_TOKEN` | A Coolify API token with `deploy` permission |
| `COOLIFY_APP_UUID` | `terraform output -raw application_uuid` |

You can delete the old `HOST`, `USERNAME` and `PRIVATE_KEY` secrets once the move is done.

## 4. Move data from the old docker-compose stack

Run these on the server. Take the dump **before** stopping the old stack.

```bash
# 1. Dump the old database
docker exec cinetra-postgres pg_dump -U cinetra -Fc cinetra > cinetra.dump

# 2. Stop the old stack (frees port 3000 and the old containers)
cd /root/cinetra && docker compose down        # add -v only once you're sure the dump is good

# 3. Restore into the Coolify database (its container name is its UUID)
DB=$(terraform output -raw database_uuid)      # run this one locally, then use the value on the server
docker exec -i "$DB" pg_restore -U cinetra -d cinetra --clean --if-exists --no-owner < cinetra.dump

# 4. Restart the app in the Coolify UI (or re-run the GitHub workflow)
```

If you restore after the app has started, the app's migrations will already have created the tables. `--clean --if-exists` drops and recreates them from the dump, so the data and the `_prisma_migrations` history come from the old database.

## Changing things later

- **Env vars**: edit `terraform.tfvars` and `terraform apply`. Changed env vars trigger a redeploy.
- **Force a redeploy from Terraform**: `terraform apply -replace=coolify_deployment.app`.
