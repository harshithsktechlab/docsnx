#!/bin/bash
docker run --rm --network standalone-apps-network -v /home/ubuntu/docsnx:/app -w /app node:22-slim bash -c '
  apt-get update && apt-get install -y postgresql-client
  export DATABASE_URL="postgresql://admin:dev_secure_2026@shared-postgres:5432/docsnx_db"
  psql $DATABASE_URL -f scripts/insert_superadmin.sql
'
