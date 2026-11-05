# uEngine ERP Docker 설치판

내 컴퓨터 한 대에서 uEngine ERP 를 돌리는 묶음입니다. 앱과 함께 Supabase(데이터베이스, 로그인, API, 실시간)까지 들어 있어서 Supabase 클라우드 프로젝트를 만들거나 SQL 을 붙여 넣을 필요가 없습니다.

내려받고, 명령 하나를 실행하고, 브라우저를 열면 바로 「회사 만들기」 화면이 나옵니다. 데이터베이스 설치는 이미 끝나 있습니다.

## 필요한 것

- Docker: macOS 는 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 이나 [colima](https://github.com/abiosoft/colima), Linux 는 Docker Engine 과 `docker compose` 플러그인
- Docker 가 쓸 메모리 4 GB 이상 (colima 는 `colima start --memory 4`)
- 디스크 10 GB 이상 (이미지를 약 1.5 GB 받고, 풀면 약 7 GB 가 됩니다)
- CPU: x86_64(Intel·AMD) 와 arm64(Apple Silicon) 모두 됩니다
- Windows 는 WSL2 에 Ubuntu 를 깔고 Docker Desktop 의 WSL 연동을 켠 뒤, **WSL 터미널 안에서** 아래 명령을 실행합니다. 압축도 WSL 쪽 폴더(예: `~/uengine-erp`)에 푸세요.

colima 는 기본으로 홈 폴더만 Docker 와 공유합니다. 압축은 홈 폴더 아래(예: `~/Downloads`)에 푸세요. 다른 곳이면 `install.sh` 가 알려 줍니다.

## 설치와 시작

```sh
curl -LO https://uengine-oss.github.io/uengine-erp/uengine-erp-docker.zip
unzip uengine-erp-docker.zip
cd uengine-erp-docker-*
./install.sh
```

이 주소는 앱을 배포할 때마다 새로 만든 최신 묶음을 줍니다. 받은 파일을 확인하려면 같은 주소에 `.sha256` 을 붙여 받아 `shasum -a 256 -c uengine-erp-docker.zip.sha256` 을 실행합니다.

처음에는 이미지를 받고 데이터베이스를 설치하느라 몇 분 걸립니다. 끝나면 주소가 나옵니다.

```
준비됐습니다. 브라우저에서 여세요:  http://127.0.0.1:57300
```

그 주소를 열면 「회사 만들기」 화면입니다. 회사 이름과 첫 관리자 계정을 넣으면 바로 로그인됩니다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `./install.sh` | 시작. 처음이면 `.env` 를 만들고 데이터베이스를 설치합니다 |
| `./install.sh stop` | 멈춤. 데이터는 남습니다 |
| `./install.sh status` | 무엇이 돌고 있는지, 데이터베이스가 무엇을 답하는지 |
| `./install.sh backup` | 데이터베이스 전체를 `backups/` 에 저장 |
| `./install.sh upgrade` | 백업한 뒤 새 버전의 설치 SQL 을 다시 실행 |
| `./install.sh reset` | 데이터를 모두 지움 (한 번 더 묻습니다) |

컴퓨터를 다시 켜도 Docker 가 켜지면 ERP 도 따라 켜집니다. `./install.sh stop` 으로 멈췄다면 `./install.sh` 로 다시 켭니다.

## 포트

모두 이 컴퓨터(127.0.0.1)에서만 열립니다. 같은 네트워크의 다른 컴퓨터에서는 접속할 수 없습니다.

| 포트 | 용도 |
|---|---|
| 57300 | 앱(브라우저로 여는 주소) |
| 57321 | API 게이트웨이(앱이 데이터베이스, 로그인, 실시간에 접속하는 곳) |

데이터베이스는 바깥에 포트를 열지 않습니다.

다른 프로그램이 이 포트를 쓰고 있으면 `.env` 의 `ERP_APP_PORT`, `ERP_API_PORT` 를 바꾸고 `./install.sh` 를 다시 실행하세요. 처음 설치할 때 정하려면 `ERP_APP_PORT=58300 ERP_API_PORT=58321 ./install.sh` 처럼 실행합니다.

브라우저는 앱 주소마다 접속 정보를 따로 기억합니다. API 포트를 바꿀 때는 앱 포트도 함께 바꾸세요. 그러면 새 앱 주소에서 바로 새 API 에 연결합니다.

## 데이터는 어디에

Docker 볼륨 `uengine-erp-docker_db-data` 에 있습니다. 압축을 푼 폴더를 지워도 볼륨은 남고, `./install.sh reset` 이나 `docker volume rm` 으로만 지워집니다.

`.env` 에는 이 설치의 데이터베이스 비밀번호와 키가 있습니다. 데이터와 짝이므로 함께 보관하세요. `.env` 를 잃으면 데이터베이스에 다시 접속할 수 없습니다.

## 백업

```sh
./install.sh backup
```

`backups/erp-날짜-시각.dump` 가 생깁니다. 직접 하려면:

```sh
docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U supabase_admin -d postgres -Fc' > erp.dump
```

앱의 「설정 > 백업」에서 원장을 파일로 내려받을 수도 있습니다.

## 업그레이드

1. 새 버전 압축을 **같은 폴더에 덮어 풉니다.** `.env` 는 압축에 들어 있지 않아 그대로 남습니다.
   새 폴더에 풀었다면 예전 폴더의 `.env` 를 새 폴더로 복사하세요.
2. `./install.sh upgrade`

먼저 `backups/` 에 백업하고, 새 설치 SQL 을 실행합니다. 설치 SQL 은 여러 번 실행해도 데이터를 지우지 않습니다. 평소의 `./install.sh` 도 설치 SQL 이 바뀌었으면 알아서 다시 실행합니다.

## 보안

- 앱과 API 는 127.0.0.1 에서만 열립니다. 이 컴퓨터의 사람과 프로그램만 접속할 수 있습니다.
- 회사가 생기기 전에는 앱 주소의 `erp-config.json` 이 설치 코드를 알려 줍니다. 그래서 SQL 없이 회사를 만들 수 있습니다. 127.0.0.1 에서만 열리기 때문에 괜찮은 방식이고, 회사를 만들면 그 코드는 더 쓰이지 않습니다.
- 비밀번호와 키는 설치마다 무작위로 만들어 `.env` 에만 둡니다. 브라우저에는 공개 키(anon)만 갑니다. 전체 권한 키(service_role)는 어느 컨테이너에도, 브라우저에도 가지 않습니다.
- 메일 서버가 없어서 메일을 보내지 않습니다. 계정은 관리자가 「설정 > 구성원」에서 만듭니다.
- **다른 컴퓨터에서 접속하게 열려면** 포트 설정만 바꾸지 마세요. HTTPS 를 붙인 역방향 프록시, 새 키(`.env` 를 새로 만들고 reset), 방화벽이 필요합니다. 그럴 바에는 Supabase 클라우드 프로젝트를 쓰는 편이 쉽습니다.

## 클라우드 방식과 다른 점

| | Docker 설치판 | 클라우드(GitHub Pages + Supabase 프로젝트) |
|---|---|---|
| 준비 | Docker 만 | Supabase 가입, 프로젝트 만들기 |
| 데이터베이스 설치 | 자동 | 앱이 주는 SQL 을 SQL Editor 에 붙여 넣기 |
| 접속 | 이 컴퓨터에서만 | 어디서나, 여러 사람이 |
| 데이터 위치 | 이 컴퓨터의 Docker 볼륨 | 회사의 Supabase 프로젝트 |
| 백업 | `./install.sh backup` | Supabase 대시보드 |
| 경비 영수증 첨부 | 안 됨(Storage 를 넣지 않음) | 됨 |

앱과 설치 SQL 은 같은 버전의 같은 파일입니다.

## 구성

`docker-compose.yml` 은 Supabase 공식 셀프 호스팅 구성에서 ERP 에 필요한 것만 남겼습니다. 이미지 버전은 Supabase CLI 2.75.0 의 로컬 스택과 같아서, ERP 의 자동 시험이 도는 환경과 같습니다.

| 서비스 | 이미지 | 역할 |
|---|---|---|
| db | supabase/postgres 17.6.1.075 | PostgreSQL, pg_cron |
| erp-init | (db 와 같은 이미지) | 설치 SQL 실행, 설치 코드 저장 후 종료 |
| auth | supabase/gotrue v2.186.0 | 로그인 |
| rest | supabase/postgrest v14.3 | API |
| realtime | supabase/realtime v2.73.2 | 실시간 알림 |
| kong | supabase/kong 2.8.1 | API 게이트웨이 |
| erp-web | nginx 1.28.0-alpine | 앱 파일과 `erp-config.json` |

Studio, Storage, 메일, 엣지 함수는 넣지 않았습니다.
