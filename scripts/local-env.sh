# Exports local Supabase URL and keys. Values come from the running stack; never commit them.
# Source it from the repository root, or set ERP_ROOT.
export DOCKER_HOST=unix://$HOME/.colima/erp/docker.sock
eval "$(supabase status --workdir "${ERP_ROOT:-$PWD}" -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|PUBLISHABLE_KEY|SERVICE_ROLE_KEY)=' | sed 's/^/export /')"
