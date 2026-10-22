#!/usr/bin/env bash
# Проба Parser-API: какие поля в примере ответа «детальная информация по делу»
# (есть ли связь «В ответ на», заседания, файлы) и есть ли CORS при запросе
# со страницы. Ключа нет — смотрим документацию и заголовки.
set -u
page=$(curl -sSL -m 30 -A 'Mozilla/5.0' 'https://parser-api.com/kad-arbitr-ru')
echo "размер страницы документации: ${#page}"
echo '== ключи JSON в примерах ответа (уникальные):'
printf '%s' "$page" | sed -e 's/&quot;/"/g' | grep -oE '"[A-Za-z_]{2,40}"[[:space:]]*:' | sort | uniq -c | sort -rn | head -n 80
echo '== строки со связью документов:'
printf '%s' "$page" | sed -e 's/&quot;/"/g' -e 's/<[^>]*>/ /g' | grep -oiE '.{0,80}(Reason|AdditionalInfo|В ответ на|ответ на|Hearing|FileName|ContentTypes|Declarers).{0,80}' | head -n 25
echo '== ссылки на документацию:'
printf '%s' "$page" | grep -oE 'href="[^"]*(doc|openapi|swagger|api)[^"]*"' | sort -u | head -n 15
