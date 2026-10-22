#!/usr/bin/env bash
# Установка обработчика kad.arbitr на чистый VPS одной командой
# (Ubuntu 22.04 / 24.04, Debian 12; от root):
#
#   curl -fsSL https://raw.githubusercontent.com/okbl/kadmonitoring/claude/dispute-tracking-system-6v3mr1/tools/vps-setup.sh | bash
#
# Что делает:
#   — при памяти меньше 3 ГБ добавляет файл подкачки 2 ГБ (браузеру нужен запас);
#   — ставит Docker и git из репозиториев системы, собирает образ обработчика
#     из этого репозитория и запускает его (перезапуск — сам, после перезагрузки
#     сервера — тоже) с новым ключом доступа;
#   — ставит Caddy и получает https-сертификат для адреса <IP>.sslip.io — свой
#     домен не нужен (или задайте DOMAIN=kad.example.ru, если он есть);
#   — печатает ссылку, которая подключает обработчик к сайту программы.
#
# Повторный запуск обновляет обработчик до свежей версии и сохраняет ключ.
# Переменные: DOMAIN — свой домен; BRANCH — ветка репозитория; SKIP_TLS=1 —
# без Caddy (проверка скрипта на машине без входящих соединений).
set -euo pipefail

REPO="${REPO:-https://github.com/okbl/kadmonitoring.git}"
BRANCH="${BRANCH:-claude/dispute-tracking-system-6v3mr1}"
SITE="${SITE:-https://okbl.github.io/kadmonitoring/}"
DIR=/opt/kad-handler
ENV_FILE=/etc/kad-handler.env

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo 'Запустите от root: sudo bash … или войдите как root.'; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say '1/5 Пакеты системы'
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null

say '2/5 Память'
mem=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$(swapon --show --noheadings | wc -l)" = 0 ] && [ "$mem" -lt 3000 ]; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "памяти ${mem} МБ — добавлена подкачка 2 ГБ"
else
  echo "памяти ${mem} МБ — подкачка не нужна или уже есть"
fi

say '3/5 Docker и обработчик'
if ! command -v docker >/dev/null; then
  apt-get install -y -qq docker.io >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --depth 1 -b "$BRANCH" "$REPO" "$DIR"
fi
docker build -q -t kad-handler "$DIR" >/dev/null
echo 'образ собран'

# Ключ доступа: создаётся один раз и переживает обновления.
if [ -f "$ENV_FILE" ]; then . "$ENV_FILE"; fi
KAD_KEY="${KAD_KEY:-$(openssl rand -hex 16)}"
printf 'KAD_KEY=%s\n' "$KAD_KEY" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

docker rm -f kad-handler >/dev/null 2>&1 || true
docker volume create kad-handler-data >/dev/null
# Слушает только сам сервер: снаружи обработчик доступен через Caddy по https.
docker run -d --restart=always --name kad-handler \
  -p 127.0.0.1:8787:8787 \
  -e KAD_KEY="$KAD_KEY" \
  -v kad-handler-data:/data \
  kad-handler >/dev/null
for i in $(seq 1 30); do curl -sf http://127.0.0.1:8787/ping >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:8787/ping >/dev/null && echo 'обработчик отвечает' || { echo 'обработчик не запустился:'; docker logs --tail 30 kad-handler; exit 1; }

if [ "${SKIP_TLS:-}" = 1 ]; then
  say 'Готово (без https — SKIP_TLS=1)'
  echo "Ключ: $KAD_KEY"
  exit 0
fi

say '4/5 Адрес и https'
ip=$(curl -fsS4 https://api.ipify.org 2>/dev/null || curl -fsS4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
HOST="${DOMAIN:-$(echo "$ip" | tr . -).sslip.io}"
echo "адрес обработчика: https://$HOST"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq caddy >/dev/null 2>&1 || {
    # В репозиториях системы Caddy нет — берём с GitHub.
    ver=$(curl -fsS https://api.github.com/repos/caddyserver/caddy/releases/latest | grep -o '"tag_name": *"v[^"]*"' | grep -o 'v[0-9.]*')
    arch=$(dpkg --print-architecture)
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/${ver}/caddy_${ver#v}_linux_${arch}.tar.gz" | tar -xz -C /usr/local/bin caddy
    useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy 2>/dev/null || true
    cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
  }
fi
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
	reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

say '5/5 Проверка https'
ok=
for i in $(seq 1 40); do
  if curl -fsS "https://$HOST/ping" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ -n "$ok" ]; then echo "https://$HOST/ping отвечает"; else echo "https пока не отвечает — сертификат может выдаваться ещё минуту; проверьте: curl https://$HOST/ping"; fi

say 'Готово'
echo 'Ссылка для подключения сайта — откройте её в браузере и разошлите коллегам:'
echo
echo "  ${SITE}#handler=https://${HOST}&key=${KAD_KEY}"
echo
echo "Ключ хранится в $ENV_FILE. Обновить обработчик — запустить этот скрипт ещё раз."
