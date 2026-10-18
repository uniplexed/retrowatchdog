#!/usr/bin/env bash
# RetroWatchdog installer: sets up and starts the docker compose stack in one
# directory, asking only what it cannot guess. Safe to run again: an existing
# .env is kept and the stack is updated in place.
#
#   curl -fsSL https://raw.githubusercontent.com/uniplexed/retrowatchdog/main/scripts/install.sh | bash
#
# Non-interactive: set RETROWATCHDOG_YES=1 and any of the variables below.
#   RETROWATCHDOG_DIR       install directory            (default: ~/retrowatchdog)
#   RETROWATCHDOG_REF       git tag or branch to install (default: v1.0.0)
#   RETROWATCHDOG_NO_START  set to 1 to write the files and stop before starting
#   PUBLIC_HOST             the name or IP the app answers HTTPS on
#   COMPOSE_PROFILES        plugins to run: any of cex,ebay,vinted,wallapop
#   IGDB_CLIENT_ID, IGDB_SECRET, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET,
#   CEX_ALGOLIA_APP_ID, CEX_ALGOLIA_API_KEY, APP_PASSWORD
set -euo pipefail

REPO="uniplexed/retrowatchdog"
REF="${RETROWATCHDOG_REF:-v1.0.0}"
case "$REF" in *[!A-Za-z0-9._/-]*) fail "RETROWATCHDOG_REF may hold letters, digits, . _ / - only" ;; esac
# the README section every source with legal conditions points at
LAW_URL="https://github.com/uniplexed/retrowatchdog#about-the-sources-and-the-law"
DIR="${RETROWATCHDOG_DIR:-$HOME/retrowatchdog}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}"
YES="${RETROWATCHDOG_YES:-0}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# read from the terminal even when the script itself arrives on stdin (curl | bash)
ask() {
  local prompt="$1" default="${2:-}" answer=""
  if [ "$YES" = "1" ] || [ ! -r /dev/tty ]; then
    printf '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then prompt="$prompt [$default]"; fi
  read -r -p "$prompt: " answer </dev/tty || true
  printf '%s' "${answer:-$default}"
}
ask_secret() {
  local prompt="$1" answer=""
  if [ "$YES" = "1" ] || [ ! -r /dev/tty ]; then return; fi
  read -r -s -p "$prompt (Enter to skip): " answer </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}
yes_no() {
  local answer
  answer="$(ask "$1 (y/n)" "$2")"
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# set KEY=VALUE in an env file, replacing a line (commented or not) that sets it
set_env() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  if grep -qE "^#? ?${key}=" "$file"; then
    local tmp
    tmp="$(mktemp)"
    # ENVIRON, not -v: -v would interpret backslash escapes inside a secret
    K="$key" V="$value" awk '
      $0 ~ "^#? ?" ENVIRON["K"] "=" && !done { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next } { print }
    ' "$file" >"$tmp" && mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

say "RetroWatchdog installer (${REF})"

# ---- Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Linux" ] && yes_no "Docker is not installed. Install it now with Docker's official script?" "y"; then
    curl -fsSL https://get.docker.com | sh
    if [ "$(id -u)" -ne 0 ]; then sudo usermod -aG docker "$USER" || true; fi
  else
    fail "Docker is required. Install Docker Desktop (Windows, macOS) or Docker Engine (Linux) and run this again."
  fi
fi
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null || [ -r /dev/tty ]; then DOCKER="sudo docker"; else fail "Docker is installed but not running, or this user cannot use it."; fi
fi
$DOCKER compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command)."

# ---- Files ------------------------------------------------------------------
say "Installing into ${DIR}"
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "${RAW}/docker-compose.yml" -o docker-compose.yml || fail "Could not download docker-compose.yml from ${RAW}."
curl -fsSL "${RAW}/.env.example" -o .env.example || fail "Could not download .env.example from ${RAW}."

FIRST_RUN=0
if [ ! -f .env ]; then
  cp .env.example .env
  FIRST_RUN=1
fi

if [ "$FIRST_RUN" = "1" ]; then
  # ---- Questions (first run only; edit .env afterwards to change them) ------
  guess_host="$(hostname -I 2>/dev/null | awk '{print $1}')"
  host="$(ask "Name or IP address other devices will use to open the app" "${PUBLIC_HOST:-${guess_host:-localhost}}")"
  set_env .env PUBLIC_HOST "$host"

  say "Price sources (plugins). Each one is optional."
  echo "Read the legal notes before you say yes to a source marked (legal notes):"
  echo "  $LAW_URL"
  profiles=()
  if yes_no "CeX (UK, Spain, Ireland shops; needs CeX's public search key; legal notes)" "n"; then profiles+=(cex); fi
  if yes_no "eBay (5 markets; needs your free eBay developer keys)" "y"; then profiles+=(ebay); fi
  if yes_no "Vinted UK, France, Germany, Spain and Ireland (private sellers; legal notes)" "n"; then profiles+=(vinted); fi
  if yes_no "Wallapop Spain, Italy and Portugal (private sellers; legal notes)" "n"; then profiles+=(wallapop); fi
  if [ -n "${COMPOSE_PROFILES:-}" ]; then IFS=',' read -r -a profiles <<<"$COMPOSE_PROFILES"; fi
  set_env .env COMPOSE_PROFILES "$(IFS=,; echo "${profiles[*]:-}")"

  for p in "${profiles[@]:-}"; do
    case "$p" in
      cex)
        id="${CEX_ALGOLIA_APP_ID:-$(ask "CeX Algolia application id (Enter to set later in .env.cex)" "")}"
        key="${CEX_ALGOLIA_API_KEY:-$(ask_secret "CeX Algolia search-only key")}"
        [ -n "$id" ] && set_env .env.cex CEX_ALGOLIA_APP_ID "$id"
        [ -n "$key" ] && set_env .env.cex CEX_ALGOLIA_API_KEY "$key"
        touch .env.cex ;;
      ebay)
        id="${EBAY_CLIENT_ID:-$(ask "eBay client id (Enter to set later in .env.ebay)" "")}"
        secret="${EBAY_CLIENT_SECRET:-$(ask_secret "eBay client secret")}"
        [ -n "$id" ] && set_env .env.ebay EBAY_CLIENT_ID "$id"
        [ -n "$secret" ] && set_env .env.ebay EBAY_CLIENT_SECRET "$secret"
        touch .env.ebay ;;
    esac
  done

  say "Game catalogue (IGDB, free at dev.twitch.tv). Optional: without it search only finds games already imported."
  igdb_id="${IGDB_CLIENT_ID:-$(ask "IGDB client id (Enter to skip)" "")}"
  if [ -n "$igdb_id" ]; then
    set_env .env IGDB_CLIENT_ID "$igdb_id"
    set_env .env IGDB_SECRET "${IGDB_SECRET:-$(ask_secret "IGDB secret")}"
  fi

  say "Password. The app has no accounts: anyone who can reach it can change it."
  password="${APP_PASSWORD:-$(ask_secret "Choose a password for the app")}"
  if [ -n "$password" ]; then
    # on stdin, not as an argument: an argument is visible in the process list
    hash="$(printf '%s' "$password" | $DOCKER run --rm -i caddy:2-alpine caddy hash-password)"
    set_env .env APP_USER "retro"
    # a bcrypt hash holds "$": compose would read it as a variable, so each one is doubled
    set_env .env APP_PASSWORD_HASH "${hash//\$/\$\$}"
  else
    printf 'No password set. Only run it on a network where everyone may use it.\n'
  fi
fi
# every run: the files hold keys and the password hash
chmod 600 .env .env.* 2>/dev/null || true

# ---- Images: the release this installer installs, on every run --------------
# A release tag (v1.2.3) pins the app to 1.2.3 and each plugin to the version
# it was released with; any other ref keeps the
# compose defaults (:latest, the newest build of main).
case "$REF" in
  v[0-9]*)
    version="${REF#v}"
    # the plugins this release was tested with; each has its own version
    for pin in "API_IMAGE retrowatchdog-api $version" "WEB_IMAGE retrowatchdog-web $version" \
      "CEX_PLUGIN_IMAGE retrowatchdog-cex-plugin 1.0.0" "EBAY_PLUGIN_IMAGE retrowatchdog-ebay-plugin 1.0.0" \
      "VINTED_SIDECAR_PLUGIN_IMAGE retrowatchdog-vinted-sidecar-plugin 1.0.0" \
      "WALLAPOP_SIDECAR_PLUGIN_IMAGE retrowatchdog-wallapop-sidecar-plugin 1.0.0"; do
      set -- $pin
      set_env .env "$1" "ghcr.io/uniplexed/$2:$3"
    done ;;
esac

# ---- Start ------------------------------------------------------------------
if [ "${RETROWATCHDOG_NO_START:-0}" = "1" ]; then
  say "Files are ready in ${DIR}. Edit .env, then: cd ${DIR} && docker compose pull && docker compose up -d"
  exit 0
fi
say "Downloading and starting RetroWatchdog (this can take a few minutes the first time)"
$DOCKER compose pull
$DOCKER compose up -d --remove-orphans

host="$(grep -E '^PUBLIC_HOST=' .env | cut -d= -f2-)"
host="${host:-localhost}"
say "Waiting for the app to answer"
# any answer from the app through the web container counts (200, 401 behind the
# password, 308 to https); no answer or a proxy error means it is still starting
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost/api/settings/currencies" 2>/dev/null || true)"
  case "$code" in 000 | 502 | 503 | 504 | "") sleep 2 ;; *) break ;; esac
done

say "Done"
cat <<EOF
Open:            https://${host}   (or http://${host})
Certificate:     https://${host}/root.crt  — install it once on each device to
                 remove the browser warning and install the app on a phone.
Next steps:      Settings → Plugins: review and approve each plugin.
                 Settings → Markets: switch on the markets you want.
Files:           ${DIR}  (.env holds your settings; keep it private)
Update later:    run this installer again, or: cd ${DIR} && docker compose pull && docker compose up -d
EOF
