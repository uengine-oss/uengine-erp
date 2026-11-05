#!/bin/sh
# Writes a new .env with random secrets: database password, JWT secret, the anon and service_role keys signed with
# it, Realtime's keys and the setup code. Prints nothing secret. Needs openssl (install.sh runs it in a container
# when the computer has none).
# Usage: gen-env.sh <output file> [app port] [api port]
set -eu

out=$1
app_port=${2:-57300}
api_port=${3:-57321}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

jwt() { # role secret
  header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  now=$(date +%s)
  exp=$((now + 10 * 365 * 24 * 3600))
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$now" "$exp" | b64url)
  sig=$(printf '%s' "$header.$payload" | openssl dgst -sha256 -hmac "$2" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

jwt_secret=$(openssl rand -hex 32)

umask 077
cat > "$out" <<EOF
# uEngine ERP Docker bundle settings, written by install.sh. Keep this file private and back it up with the data.

# Ports on 127.0.0.1. After changing them run ./install.sh again.
ERP_APP_PORT=$app_port
ERP_API_PORT=$api_port

# Random for this install. Changing them while the database exists breaks logins: run ./install.sh reset first.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$jwt_secret
ANON_KEY=$(jwt anon "$jwt_secret")
# Full access that bypasses row-level security. No container and no browser gets it; it is here for your own scripts.
SERVICE_ROLE_KEY=$(jwt service_role "$jwt_secret")
SECRET_KEY_BASE=$(openssl rand -hex 32)
REALTIME_DB_ENC_KEY=$(openssl rand -hex 8)
# Lets the first browser create the company without running SQL. It stops working once the company exists.
ERP_SETUP_CODE=$(openssl rand -hex 24)
EOF
