#!/bin/sh
# Production entrypoint for docsnx.service.
#
# Secrets are no longer read from a plaintext file in the working directory.
# systemd decrypts the TPM-sealed blobs in /etc/docsnx/credentials as root and
# drops them into $CREDENTIALS_DIRECTORY -- a 0400 tmpfs inside this unit's own
# private mount namespace, so no sibling service under the shared azureuser uid
# can reach them (the failure mode behind the 2026-08-12 incident).
#
# This wrapper exists because systemd has no native "credentials as environment
# variables" directive. Exporting them here keeps the application entirely on
# process.env, so src/lib/encryption.ts, src/lib/fieldCrypto.ts and src/lib/db.ts
# -- all of which read it at import time -- need no change.
#
# Seal or re-seal a value with scripts/seal-credentials.sh.
set -eu

if [ -z "${CREDENTIALS_DIRECTORY:-}" ]; then
  # Without this guard a misconfigured unit starts a server with an undefined
  # DATABASE_URL, which surfaces much later as the baffling
  # "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string".
  echo "FATAL: \$CREDENTIALS_DIRECTORY is unset -- refusing to start without secrets." >&2
  exit 78   # EX_CONFIG
fi

for f in "$CREDENTIALS_DIRECTORY"/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  # Command substitution strips trailing newlines, which is correct: the seal
  # script writes values with printf '%s', so there are none to preserve.
  export "$name=$(cat "$f")"
done

# Fail at boot rather than on the first request that touches the vault.
for required in DATABASE_URL JWT_SECRET ENCRYPTION_SECRET; do
  eval "value=\${$required:-}"
  if [ -z "$value" ]; then
    echo "FATAL: $required missing from credentials -- is it sealed and listed in the unit?" >&2
    exit 78
  fi
done

exec /opt/docsnx/node_modules/.bin/next start -p 3005 -H 127.0.0.1
