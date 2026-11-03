# Exports local Supabase URL and keys. Values come from the running stack; never commit them.
export DOCKER_HOST=unix://$HOME/.colima/erp/docker.sock
eval "$(supabase status --workdir /Users/uengine/uengine-platform/uengine-erp -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|PUBLISHABLE_KEY|SERVICE_ROLE_KEY)=' | sed 's/^/export /')"
