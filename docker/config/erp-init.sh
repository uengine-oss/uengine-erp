#!/bin/sh
# Runs on every `docker compose up` and exits. It installs the ERP schema the first time, upgrades it when this
# bundle's install.sql differs from the one last applied, and sets the setup code while no company exists.
# install.sql is idempotent and never deletes data, so running it again is always safe.
set -eu

until pg_isready -q; do sleep 1; done
until psql -XtAq -c 'select 1' >/dev/null 2>&1; do sleep 1; done

want=$(sha256sum /erp/install.sql | cut -d' ' -f1)
have=$(psql -XtAq -c "select value #>> '{}' from erp.meta where key = 'docker_install_sha256'" 2>/dev/null || true)

if [ "$want" != "$have" ] || [ "${ERP_FORCE_INSTALL:-0}" = "1" ]; then
  echo "erp-init: applying install.sql ($(wc -c < /erp/install.sql) bytes)"
  started=$(date +%s)
  # Notices such as "already exists, skipping" are noise on an upgrade; errors still stop the script.
  PGOPTIONS='-c client_min_messages=warning' psql -Xq -v ON_ERROR_STOP=1 -f /erp/install.sql >/dev/null
  psql -Xq -v ON_ERROR_STOP=1 -v sha="$want" >/dev/null <<'SQL'
insert into erp.meta(key, value) values ('docker_install_sha256', to_jsonb(:'sha'::text))
  on conflict (key) do update set value = excluded.value;
SQL
  echo "erp-init: install.sql applied in $(( $(date +%s) - started ))s"
else
  echo "erp-init: database already has this install.sql"
fi

# erp_bootstrap accepts the code only while the company has no members, and deletes it once used.
if [ -n "${ERP_SETUP_CODE:-}" ]; then
  psql -Xq -v ON_ERROR_STOP=1 -v code="$ERP_SETUP_CODE" >/dev/null <<'SQL'
select erp.set_setup_code(:'code') where not exists (select 1 from erp.members);
SQL
fi

cron=$(psql -XtAq -c "select value #>> '{}' from erp.meta where key = 'bus_cron'")
[ "$cron" = "true" ] || echo "erp-init: WARNING pg_cron did not schedule the module bus; the app's own ticks still deliver while a browser is open"
echo "erp-init: done (schema $(psql -XtAq -c "select public.erp_status() ->> 'version'"), company created: $(psql -XtAq -c "select public.erp_status() ->> 'initialized'"))"
