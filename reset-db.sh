#!/bin/bash
docker run --rm --network standalone-apps-network -v /home/ubuntu/docsnx:/app -w /app node:22-slim bash -c '
  npm install --no-save drizzle-kit tsx @types/pg pg
  apt-get update && apt-get install -y postgresql-client
  export DATABASE_URL="postgresql://admin:dev_secure_2026@shared-postgres:5432/docsnx_db?schema=public"
  psql "postgresql://admin:dev_secure_2026@shared-postgres:5432/docsnx_db" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  npx drizzle-kit push
'
