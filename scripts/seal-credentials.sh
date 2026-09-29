#!/bin/bash
# Seal docsnx's production secrets into TPM-bound systemd credentials.
#
#   sudo scripts/seal-credentials.sh seal      [env-file] # create the .cred blobs
#   sudo scripts/seal-credentials.sh verify    [env-file] # round-trip check, changes nothing
#   sudo scripts/seal-credentials.sh nonsecret [env-file] # write .env.production
#   sudo scripts/seal-credentials.sh list                 # what is sealed right now
#
# env-file defaults to /opt/docsnx/.env.local and is only read by `seal`,
# `verify` and `nonsecret`; once all three have run and the unit is live on
# credentials, it can be shredded.
#
# Values are extracted with dotenv -- the same parser Next and scripts/loadEnv.ts
# use -- rather than with grep/cut. That matters: a hand-rolled parser mishandles
# quoting and the embedded JSON in FIREBASE_SERVICE_ACCOUNT, and a single mangled
# byte in ENCRYPTION_SECRET makes every encrypted vault column unreadable.
#
# `--with-key=host+tpm2` binds each blob to this host's TPM *and* to
# /var/lib/systemd/credential.secret. The files are inert anywhere else, so
# backups and filesystem snapshots stop being a disclosure channel -- and, by the
# same token, a TPM reset or a restore onto a different host makes them
# permanently undecryptable. Keep the authoritative copy in a password manager.
set -euo pipefail

APP_DIR=/opt/docsnx
CRED_DIR=/etc/docsnx/credentials
ACTION="${1:-}"
ENV_FILE="${2:-$APP_DIR/.env.local}"

# Secrets only. Non-secret configuration -- the NEXT_PUBLIC_* build-time values
# and the public halves of key pairs such as RAZORPAY_KEY_ID and
# GOOGLE_CLIENT_ID -- goes to .env.production via the `nonsecret` action below,
# where it stays greppable and reviewable. PORT, APP_URL, HOSTNAME, NODE_ENV and
# UPLOAD_DIR are already Environment= lines in the unit.
#
# Editing this list? Add a matching LoadCredentialEncrypted= line to
# docsnx.service, or the value will be sealed but never delivered.
SECRETS=(
  DATABASE_URL
  JWT_SECRET
  UDYAMNX_JWT_SECRET
  ENCRYPTION_SECRET
  BLIND_INDEX_KEY
  GEMINI_API_KEY
  GOOGLE_CLIENT_SECRET
  RAZORPAY_KEY_SECRET
  RAZORPAY_WEBHOOK_SECRET
  FIREBASE_SERVICE_ACCOUNT
  AZURE_STORAGE_CONNECTION_STRING
  NOTIFICATION_SERVICE_API_KEY
)

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (systemd-creds needs /var/lib/systemd/credential.secret)"

# Print one value from the env file, raw, with no trailing newline. Exits 3 when
# the key is absent or empty so the caller can skip it rather than seal "".
emit_value() {
  NODE_PATH="$APP_DIR/node_modules" node -e '
    const fs = require("fs");
    const dotenv = require("dotenv");
    const [file, key] = process.argv.slice(1);
    const parsed = dotenv.parse(fs.readFileSync(file));
    const value = parsed[key];
    if (value === undefined || value === "") process.exit(3);
    process.stdout.write(value);
  ' "$ENV_FILE" "$1"
}

case "$ACTION" in
  seal)
    [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE"
    install -d -m 0700 -o root -g root "$CRED_DIR"
    sealed=0 skipped=0
    for name in "${SECRETS[@]}"; do
      # Pipe straight into systemd-creds: the value never lands in a shell
      # variable (which would strip trailing bytes) nor on disk in cleartext.
      if emit_value "$name" | systemd-creds encrypt \
           --with-key=host+tpm2 --name="$name" - "$CRED_DIR/$name.cred"; then
        chmod 0400 "$CRED_DIR/$name.cred"
        echo "  sealed   $name"
        (( ++sealed ))
      else
        rm -f "$CRED_DIR/$name.cred"
        echo "  SKIPPED  $name (unset or empty in $(basename "$ENV_FILE"))"
        (( ++skipped ))
      fi
    done
    echo
    echo "$sealed sealed, $skipped skipped -> $CRED_DIR"
    echo "Next: scripts/seal-credentials.sh verify, then install the unit file."
    ;;

  verify)
    [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE"
    failed=0
    for name in "${SECRETS[@]}"; do
      blob="$CRED_DIR/$name.cred"
      if [[ ! -f "$blob" ]]; then
        # Consistent with `seal`: a key absent from the env file is not sealed.
        if emit_value "$name" >/dev/null 2>&1; then
          echo "  MISSING  $name (present in env file but not sealed)"
          failed=1
        else
          echo "  n/a      $name (unset in env file, correctly not sealed)"
        fi
        continue
      fi
      # --name= binds the blob to this credential name, so a swapped file fails
      # here rather than silently feeding the wrong value to the app.
      if diff -q <(systemd-creds decrypt --name="$name" "$blob" -) \
                 <(emit_value "$name") >/dev/null 2>&1; then
        echo "  OK       $name"
      else
        echo "  MISMATCH $name -- sealed value differs from the env file"
        failed=1
      fi
    done
    echo
    [[ $failed -eq 0 ]] && echo "all sealed values round-trip byte-for-byte" \
                        || die "one or more credentials do not match -- do not shred the env file"
    ;;

  nonsecret)
    # Everything that is NOT a secret has to survive the env file being shredded.
    # NEXT_PUBLIC_* especially: `next build` runs as azureuser outside systemd and
    # never sees $CREDENTIALS_DIRECTORY, so a missing value there silently ships a
    # client bundle with an undefined Firebase config rather than failing.
    # .env.production is loaded by both `next build` and `next start`, so one file
    # covers both, and .gitignore's `.env*` already keeps it out of the repo.
    [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE"
    OUT="$APP_DIR/.env.production"
    [[ -e "$OUT" ]] && die "$OUT already exists -- move it aside first"

    OUT="$OUT" NODE_PATH="$APP_DIR/node_modules" node -e '
      const fs = require("fs");
      const dotenv = require("dotenv");
      const [file, secretList] = process.argv.slice(1);
      const secrets = new Set(secretList.split(","));
      // Already set as Environment= in the unit; repeating them here would just
      // be a second place to keep in sync.
      const fromUnit = new Set(["NODE_ENV","PORT","HOSTNAME","APP_URL","UPLOAD_DIR"]);
      const parsed = dotenv.parse(fs.readFileSync(file));
      const lines = [
        "# Non-secret configuration for docsnx, split out of the old .env.local.",
        "# Loaded by both `next build` and `next start` from the working directory.",
        "#",
        "# Secrets do NOT belong here -- they are TPM-sealed under",
        "# /etc/docsnx/credentials and delivered by systemd. See docsnx.service.",
        "",
      ];
      const skipped = [];
      for (const [key, value] of Object.entries(parsed)) {
        if (secrets.has(key) || fromUnit.has(key)) continue;
        if (/^[A-Za-z0-9_.:\/@+=-]*$/.test(value)) {
          lines.push(`${key}=${value}`);
        } else if (!/["\\\n\r]/.test(value)) {
          lines.push(`${key}="${value}"`);   // spaces, #, etc. — quoting is enough
        } else {
          // Quotes, backslashes or newlines do not round-trip through dotenv
          // reliably. Refuse to guess; the operator copies these by hand.
          skipped.push(key);
        }
      }
      fs.writeFileSync(process.env.OUT, lines.join("\n") + "\n");
      const written = lines.length - 6;
      console.log(`  wrote ${written} non-secret values -> ${process.env.OUT}`);
      if (skipped.length) {
        console.log("");
        console.log("  NEEDS MANUAL COPY (value contains quotes/backslashes/newlines):");
        for (const key of skipped) console.log(`    ${key}`);
        process.exitCode = 1;
      }
    ' "$ENV_FILE" "$(IFS=,; echo "${SECRETS[*]}")" || nonsecret_incomplete=1

    chown azureuser:azureuser "$OUT"
    chmod 0644 "$OUT"
    echo
    if [[ -n "${nonsecret_incomplete:-}" ]]; then
      die "copy the values listed above into $OUT by hand before shredding the env file"
    fi
    echo "Confirm NEXT_PUBLIC_* are all present, then run: npm run build"
    ;;

  list)
    ls -la "$CRED_DIR" 2>/dev/null || die "$CRED_DIR does not exist yet"
    ;;

  *)
    sed -n '2,11p' "$0" >&2
    exit 64  # EX_USAGE
    ;;
esac
