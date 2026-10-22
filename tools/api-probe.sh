#!/usr/bin/env bash
# Проба сторонних API с данными kad.arbitr: отвечают ли запросам со страницы
# сайта (CORS) и что написано в документации о делах, документах и ценах.
# Ключей нет — смотрим заголовки и ответ без ключа. Данных дел здесь нет.
set -u
ORIGIN='https://okbl.github.io'
cors() {
  echo "== $1"
  curl -sS -m 20 -o /dev/null -D - -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: GET' "$1" 2>&1 | grep -iE '^(HTTP|access-control)' | tr -d '\r'
  echo '-- GET:'
  curl -sS -m 20 -D /tmp/h.txt -H "Origin: $ORIGIN" "$1" 2>&1 | head -c 300; echo
  grep -iE '^(HTTP|access-control|content-type)' /tmp/h.txt | tr -d '\r'
}
doc() {
  echo "== документация $1"
  curl -sSL -m 25 -A 'Mozilla/5.0' "$1" 2>&1 | sed -e 's/<[^>]*>/ /g' | tr -s ' \t' ' ' | grep -iE "$2" | head -n 25 | cut -c1-300
}
cors 'https://parser-api.com/parser/arbitr_api/details_by_number?key=test&CaseNumber=A40-1/2025'
cors 'https://api.damia.ru/arb/delo?regn=A40-1/2025&key=test'
cors 'https://api.checko.ru/v2/legal-cases?key=test&inn=7707083893'
cors 'https://api.ofdata.ru/v2/legal-cases?key=test&inn=7707083893'
cors 'https://api-cloud.ru/api/kad.php?type=search&token=test'
doc 'https://parser-api.com/kad-arbitr-ru' 'details|документ|хронолог|pdf|руб|cors|запрос|ответ на|ReasonDocument|instance'
doc 'https://damia.ru/apiarb' 'delo|документ|хронолог|pdf|руб|cors|событ|заседан'
doc 'https://api-cloud.ru/api/kad' 'kad|документ|хронолог|pdf|руб|cors|метод'
