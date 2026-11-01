FROM node:25.1.0-alpine3.22 AS node-pnpm

# Pinned pnpm: the unpinned get.pnpm.io script started installing pnpm 12,
# which puts the binary in $PNPM_HOME/bin and broke `pnpm` on PATH.
RUN npm install -g pnpm@10.18.3

FROM node-pnpm AS frontend-builder

WORKDIR /frontend

COPY frontend/package.json .
COPY frontend/pnpm-lock.yaml .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY frontend .

RUN pnpm build

FROM node-pnpm

WORKDIR /backend

COPY backend/package.json .
COPY backend/pnpm-lock.yaml .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY backend .

# prisma.config.ts requires DATABASE_URL to load; generate never connects, so a placeholder is enough.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm prisma generate

RUN pnpm build

COPY --from=frontend-builder /frontend/dist ./dist/ui

# Apply pending Prisma migrations before starting (replaces the compose "migrate" service).
CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm start"]
