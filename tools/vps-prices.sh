#!/usr/bin/env bash
# Цены самых дешёвых VPS у российских хостингов — для размещения обработчика.
# Страницы тарифов публичные; печатаются строки с ценами и объёмом памяти.
set -u
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
show() {
  echo "=================== $1"
  curl -sSL -m 30 -A "$UA" -H 'Accept-Language: ru-RU,ru' "$1" 2>&1 \
    | sed -e 's/<script[^>]*>.*<\/script>//g' -e 's/<[^>]*>/ /g' -e 's/&nbsp;/ /g' -e 's/&#8381;/₽/g' -e 's/\\u20bd/₽/g' \
    | tr -s ' \t' ' ' | grep -E '₽|руб' | grep -iE 'ГБ|GB|RAM|ОЗУ|мес|vCPU|CPU|ядр' | head -n "${2:-15}" | cut -c1-260
}
show 'https://timeweb.cloud/services/cloud-servers'
show 'https://timeweb.cloud/price'
show 'https://beget.com/ru/vps'
show 'https://vdsina.com/ru/cloud-servers'
show 'https://firstvds.ru/products/vds_vps'
show 'https://aeza.net/ru/virtual-servers'
show 'https://ruvds.com/ru-rub/pricing'
show 'https://www.reg.ru/vps/'
show 'https://selectel.ru/services/cloud/servers/'
show 'https://sprinthost.ru/vps.html'
show 'https://hostkey.ru/vps/'
