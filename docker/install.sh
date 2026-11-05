#!/bin/sh
# uEngine ERP Docker bundle (macOS, Linux, Windows through WSL).
#
#   ./install.sh            start: create .env if missing, start everything, wait for the database, print the URL
#   ./install.sh stop       stop and remove the containers; the data stays
#   ./install.sh status     what is running and what the database answers
#   ./install.sh backup     pg_dump of the whole database into ./backups/
#   ./install.sh upgrade    back up, then run this bundle's install.sql again (it never deletes data)
#   ./install.sh reset      delete all data after asking (add --yes to skip the question)
#
# Never prints a key or password. They live only in .env.
set -eu

cd "$(dirname "$0")"
HERE=$(pwd)
ENV_FILE="$HERE/.env"

say() { printf '%s\n' "$*"; }
die() { printf '오류: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- checks
check_docker() {
  command -v docker >/dev/null 2>&1 || die "docker 명령이 없습니다. Docker Desktop 이나 colima 를 설치하세요 (README.md)."
  docker info >/dev/null 2>&1 || die "Docker 가 실행 중이 아닙니다. Docker Desktop 을 켜거나 'colima start' 를 실행하세요."
  docker compose version >/dev/null 2>&1 || die "'docker compose'(v2) 가 필요합니다. Docker Desktop 이나 docker-compose-plugin 을 설치하세요."
  mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  if [ "${mem:-0}" -gt 0 ] && [ "$mem" -lt 3000000000 ]; then
    say "주의: Docker 가 쓸 수 있는 메모리가 $((mem / 1048576)) MB 입니다. 4 GB 이상을 권합니다."
  fi
  arch=$(docker info --format '{{.Architecture}}' 2>/dev/null || echo unknown)
  case "$arch" in
    x86_64|amd64|aarch64|arm64) ;;
    *) say "주의: 이 Docker 의 CPU 종류($arch)용 이미지가 없을 수 있습니다. x86_64 와 arm64 만 시험했습니다." ;;
  esac
}

ensure_env() {
  [ -f "$ENV_FILE" ] && return 0
  say ".env 를 만듭니다 (무작위 비밀번호와 키)."
  if command -v openssl >/dev/null 2>&1; then
    sh "$HERE/config/gen-env.sh" "$ENV_FILE" "${ERP_APP_PORT:-57300}" "${ERP_API_PORT:-57321}"
  else
    # No openssl here: the Postgres image has one.
    docker run --rm -v "$HERE:/w" --entrypoint sh public.ecr.aws/supabase/postgres:17.6.1.075 \
      /w/config/gen-env.sh /w/.env "${ERP_APP_PORT:-57300}" "${ERP_API_PORT:-57321}"
  fi
  chmod 600 "$ENV_FILE"
}

load_env() {
  [ -f "$ENV_FILE" ] || die ".env 가 없습니다. 먼저 ./install.sh 를 실행하세요. 다른 폴더에서 옮겨 왔다면 예전 폴더의 .env 를 복사하세요."
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  APP_URL="http://127.0.0.1:${ERP_APP_PORT}"
  API_URL="http://127.0.0.1:${ERP_API_PORT}"
}

# colima shares only the home folder with its VM by default; outside it the mounts below are empty folders.
check_mounts() {
  if ! docker run --rm -v "$HERE/config:/c:ro" --entrypoint sh public.ecr.aws/nginx/nginx:1.28.0-alpine -c 'test -f /c/kong.yml' >/dev/null 2>&1; then
    die "Docker 가 이 폴더($HERE)의 파일을 보지 못합니다. colima 는 기본으로 홈 폴더만 공유하니, 홈 폴더 아래로 옮겨 다시 실행하세요."
  fi
}

pull_images() {
  say "이미지를 받습니다. 처음에는 약 1.5 GB 라 몇 분 걸립니다."
  compose pull || say "주의: 이미지를 받지 못했습니다. 이미 받아 둔 이미지로 계속합니다."
}

compose() { docker compose --env-file "$ENV_FILE" -f "$HERE/docker-compose.yml" "$@"; }

check_config() { compose config -q || die "docker-compose.yml 이나 .env 를 읽지 못했습니다. 위 오류를 확인하세요."; }

volume_exists() { [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=uengine-erp-docker" --filter "label=com.docker.compose.volume=db-data")" ]; }

# ---------------------------------------------------------------- waiting
erp_status() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -X POST "$API_URL/rest/v1/rpc/erp_status" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' -d '{}' 2>/dev/null || true
  else
    compose exec -T db psql -U postgres -XtAq -c 'select public.erp_status()' 2>/dev/null || true
  fi
}

wait_ready() {
  say "데이터베이스 설치를 기다립니다. 처음에는 1~3분 걸립니다."
  i=0
  while :; do
    id=$(compose ps -a -q erp-init 2>/dev/null || true)
    state=$( [ -n "$id" ] && docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$id" 2>/dev/null || echo "missing 0")
    case "$state" in
      "exited 0") break ;;
      exited*)
        compose logs --no-color --tail 40 erp-init >&2 || true
        die "데이터베이스 설치(erp-init)가 실패했습니다. 위 기록을 확인하세요." ;;
    esac
    i=$((i + 1))
    [ "$i" -lt 600 ] || die "설치가 10분 안에 끝나지 않았습니다. 'docker compose logs erp-init' 을 확인하세요."
    [ $((i % 30)) -ne 0 ] || say "  아직 설치 중입니다 (${i}초)"
    sleep 1
  done
  compose logs --no-color erp-init 2>/dev/null | grep -o 'erp-init: .*' | tail -3 || true
  i=0
  until erp_status | grep -Eq '"installed": *true'; do
    i=$((i + 1))
    [ "$i" -lt 120 ] || die "API($API_URL)가 응답하지 않습니다. './install.sh status' 로 확인하세요."
    sleep 1
  done
  wait_realtime
}

# Realtime answers for a few seconds while it seeds its tenant, then restarts as the real server. A browser that
# subscribes in between loses its live updates until reload, so the URL is printed only after the restart.
wait_realtime() {
  command -v curl >/dev/null 2>&1 || return 0
  id=$(compose ps -q realtime 2>/dev/null || true)
  [ -n "$id" ] || return 0
  started=$(docker inspect -f '{{.State.StartedAt}}' "$id")
  i=0
  until docker logs --since "$started" "$id" 2>&1 | grep -q 'Starting Realtime' \
    && curl -fsS -m 3 --head -o /dev/null "$API_URL/realtime/v1/api/ping" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 180 ]; then say "주의: 실시간 서버가 3분 안에 뜨지 않았습니다. 앱은 쓸 수 있고, 화면은 새로 고칠 때 갱신됩니다."; return 0; fi
    sleep 1
  done
}

print_done() {
  say ""
  say "준비됐습니다. 브라우저에서 여세요:  $APP_URL"
  if erp_status | grep -Eq '"initialized": *false'; then
    say "처음 열면 '회사 만들기' 화면이 나옵니다."
  fi
  say "멈추기: ./install.sh stop    상태: ./install.sh status"
}

# ---------------------------------------------------------------- commands
cmd_start() {
  check_docker
  ensure_env
  load_env
  check_config
  pull_images
  check_mounts
  if ! compose up -d --remove-orphans; then
    die "시작하지 못했습니다. 포트 ${ERP_APP_PORT} 이나 ${ERP_API_PORT} 를 다른 프로그램이 쓰고 있다면 .env 에서 ERP_APP_PORT, ERP_API_PORT 를 바꾸세요."
  fi
  wait_ready
  print_done
}

cmd_stop() {
  check_docker
  load_env
  compose down
  say "멈췄습니다. 데이터는 Docker 볼륨 uengine-erp-docker_db-data 에 남아 있습니다. 다시 켜기: ./install.sh"
}

cmd_status() {
  check_docker
  load_env
  compose ps -a
  say ""
  status=$(erp_status)
  if [ -n "$status" ]; then say "erp_status: $status"; else say "API($API_URL)가 응답하지 않습니다."; fi
  say "앱 주소: $APP_URL   API 주소: $API_URL"
}

cmd_backup() {
  check_docker
  load_env
  compose up -d --wait db >/dev/null
  mkdir -p "$HERE/backups"
  file="$HERE/backups/erp-$(date +%Y%m%d-%H%M%S).dump"
  # supabase_admin owns Supabase's own schemas, so the dump has no permission gaps. The password is read inside
  # the container, so it never appears on this computer's command line.
  if ! compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U supabase_admin -d postgres -Fc' > "$file"; then
    rm -f "$file"
    die "백업하지 못했습니다. 위 오류를 확인하세요."
  fi
  chmod 600 "$file"
  say "백업했습니다: $file ($(wc -c < "$file" | tr -d ' ') bytes)"
}

cmd_upgrade() {
  check_docker
  load_env
  check_config
  if volume_exists; then cmd_backup; fi
  pull_images
  check_mounts
  say "새 설치 SQL 을 다시 실행합니다. 데이터는 지우지 않습니다."
  ERP_FORCE_INSTALL=1
  export ERP_FORCE_INSTALL
  compose up -d --remove-orphans
  wait_ready
  print_done
}

cmd_reset() {
  check_docker
  load_env
  if [ "${1:-}" != "--yes" ]; then
    [ -t 0 ] || die "확인 없이 지우려면 ./install.sh reset --yes 를 쓰세요."
    say "회사 데이터를 모두 지웁니다(Docker 볼륨 uengine-erp-docker_db-data). 되돌릴 수 없습니다."
    printf "계속하려면 '삭제' 또는 'yes' 를 입력하세요: "
    read -r answer
    case "$answer" in 삭제|yes|YES) ;; *) say "그만둡니다."; exit 0 ;; esac
  fi
  compose down -v --remove-orphans
  say "지웠습니다. .env(키와 설치 코드)는 그대로 두었습니다. 새로 시작하려면 ./install.sh"
}

case "${1:-start}" in
  start|install|up) cmd_start ;;
  stop|down) cmd_stop ;;
  status) cmd_status ;;
  backup) cmd_backup ;;
  upgrade) cmd_upgrade ;;
  reset) cmd_reset "${2:-}" ;;
  -h|--help|help) sed -n '2,10p' "$HERE/install.sh" | sed 's/^# \{0,1\}//' ;;
  *) die "알 수 없는 명령: $1 (./install.sh help)" ;;
esac
