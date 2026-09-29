/*
 * Макет kad.arbitr.ru для проверки загрузчика: настоящая картотека из среды
 * разработки недоступна. Макет повторяет то, на что опирается загрузчик, а
 * не вёрстку картотеки: карточка догружает хронологию скриптом из JSON API
 * постранично, записи ссылаются друг на друга, акты лежат в PDF.
 *
 * Страница показывает только первую страницу хронологии — остальное
 * загрузчик должен добрать из API сам.
 */
import fs from 'fs';
import http from 'http';

export const CASE = '2aa24115-6d6f-4b9e-9c17-cd43a0bd8ef5';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const msk = (d, hh = 0, mm = 0) => {
  const [dd, mo, yy] = d.split('.').map(Number);
  return `/Date(${Date.UTC(yy, mo - 1, dd, hh - 3, mm)})/`;
};
const SBER = [{ Organization: 'ПАО "СБЕРБАНК РОССИИ"', Type: 1 }];
const FU = [{ Organization: 'Финансовый управляющий Сидоров П. П.', Type: 3 }];
const JUDGE = [{ Name: 'Петрова А. В.' }];

export const ITEMS = [
  { Id: id(1), DisplayDate: '20.06.2026', DocumentTypeName: 'Заявление', ContentTypes: ['О признании сделки недействительной'], Declarers: FU },
  { Id: id(2), DisplayDate: '23.06.2026', DocumentTypeName: 'Заявление', ContentTypes: ['О признании сделки недействительной'], Declarers: SBER },
  { Id: id(3), DisplayDate: '26.06.2026', DocumentTypeName: 'Определение', ContentTypes: ['Об оставлении заявления без движения'], Judges: JUDGE, ReasonDocumentId: id(2), FileName: 'A40-123456-2025_20260626_Opredelenie.pdf' },
  { Id: id(4), DisplayDate: '03.07.2026', DocumentTypeName: 'Определение', ContentTypes: ['О принятии заявления к производству'], Judges: JUDGE, ReasonDocumentId: id(1), FileName: 'A40-123456-2025_20260703_Opredelenie.pdf', HearingDate: msk('04.08.2026', 9, 30) },
  { Id: id(5), DisplayDate: '10.07.2026', DocumentTypeName: 'Дополнительные документы', ContentTypes: ['Во исполнение определения суда'], Declarers: SBER, ReasonDocumentId: id(3) },
  { Id: id(6), DisplayDate: '15.07.2026', DocumentTypeName: 'Определение', ContentTypes: ['О принятии заявления о признании сделки недействительной к производству'], Judges: JUDGE, ReasonDocumentId: id(2), FileName: 'A40-123456-2025_20260715_Opredelenie.pdf', HearingDate: msk('12.08.2026', 10, 30), HearingPlace: 'зал 7009' },
  { Id: id(7), DisplayDate: '05.08.2026', DocumentTypeName: 'Отзыв', ContentTypes: ['На заявление о признании сделки недействительной'], Declarers: FU, ReasonDocumentId: id(6) },
  { Id: id(8), DisplayDate: '16.09.2026', DocumentTypeName: 'Определение', ContentTypes: ['Об отложении судебного разбирательства'], Judges: JUDGE, ReasonDocumentId: id(2), FileName: 'A40-123456-2025_20260916_Opredelenie.pdf', HearingDate: msk('21.10.2026', 14, 20), HearingPlace: 'зал 7009' }
].map((x) => ({ CaseId: CASE, ...x }));

const PER_PAGE = 3;

function page(items, n) {
  const sorted = [...items].reverse();   // картотека показывает новые сверху
  return {
    Success: true,
    Result: { Page: n, PageSize: PER_PAGE, PagesCount: Math.ceil(sorted.length / PER_PAGE), TotalCount: sorted.length,
      Items: sorted.slice((n - 1) * PER_PAGE, n * PER_PAGE) }
  };
}

const CARD_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>А40-123456/2025 — Картотека</title></head>
<body>
<script>window.__kadSporTest = true;</script>
<h1>А40-123456/2025</h1>
<div>Дело о несостоятельности (банкротстве) гражданина</div>
<div>Арбитражный суд города Москвы</div>
<div>Должник: Иванов Иван Иванович</div>
<div class="b-chrono-item-header js-chrono-item-header" data-id="inst1">
  <strong>Первая инстанция</strong>
  <input type="hidden" class="js-instanceId" value="inst1">
</div>
<ul id="chrono"></ul>
<script>
fetch('/Kad/InstanceDocumentsPage?_=' + Date.now() + '&id=inst1&caseId=${CASE}&withProtocols=true&perPage=${PER_PAGE}&page=1',
  { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
  .then((r) => r.json())
  .then((j) => {
    for (const it of j.Result.Items) {
      const li = document.createElement('li');
      li.innerHTML = '<p>' + it.DisplayDate + '</p><p>' + it.DocumentTypeName + '</p>' +
        '<h2>' + (it.FileName ? '<a href="/Document/Pdf/' + it.CaseId + '/' + it.Id + '/' + it.FileName + '">' + it.ContentTypes[0] + '</a>' : it.ContentTypes[0]) + '</h2>';
      document.getElementById('chrono').append(li);
    }
  });
</script>
</body></html>`;

const passed = (req) => /(?:^|;\s*)passed=1/.test(req.headers.cookie || '');

/* Страница проверки браузера перед карточкой: скрипт ставит cookie и уводит дальше. */
const challenge = (to) => `<!DOCTYPE html><html><body><script>setTimeout(function(){document.cookie='passed=1; path=/';location.href=${JSON.stringify(to)}},300)</script></body></html>`;

/*
 * Проверка перед PDF — как у kad («salto»): скрытая форма POST с token и
 * пустым hash, в скрытом поле datat — код, записанный табуляциями и
 * пробелами (по символу на строку). Код вычисляет hash и отправляет форму;
 * на POST с верным hash отвечает файл. GET — всегда страница проверки.
 */
const SALTO = 'xcd67qm4bns';
const hashOf = (token) => [...`${token}${SALTO}`].reverse().join('');
function saltoPage(token) {
  const code = `document.getElementById('hash').value = (document.getElementById('token').value + document.getElementById('salto').textContent).split('').reverse().join(''); document.getElementById('searchForm').submit();`;
  const datat = [...code].map((c) => c.charCodeAt(0).toString(2).replace(/1/g, '\t').replace(/0/g, ' ')).join('\n') + '\n';
  return `<!DOCTYPE html><html><head></head><body>
<div id="salto" style="display:none">${SALTO}</div>
<form id="searchForm" style="display:none" method="post">
<input id="token" type="text" name="token" value="${token}"><input id="hash" type="text" name="hash"><input type="submit" value="Search">
</form>
<input id="datat" type="hidden" value="${datat}" />
<script language="javascript" type="text/javascript">
function decode(returnCode) { xcode = document.getElementById('datat').value.split("\\n"); result = ''; char_true = '\\t';
for (i in xcode) { encoded = ''; for (j in xcode[i]) encoded += (xcode[i][j] == char_true) ? "1" : "0"; chr = parseInt(encoded, 2); result += String.fromCharCode(chr.toString(10)); }
res = result.substr(0, result.length - 1); if (returnCode !== undefined) return res; document.getElementById('source').value = res; }
eval(decode("ret"))
</script></body></html>`;
}

const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });

/**
 * pdf — Buffer с PDF, который отдаётся на /Document/Pdf/… после проверки;
 * wall — показывать страницу проверки «вы не робот» вместо карточки;
 * cardCheck — карточку отдавать только браузеру, прошедшему проверку
 * (как PDF): без cookie вместо неё страница со скриптом;
 * site — страница программы, отдаётся по /site/ (как с сайта на Pages);
 * apiReferer — API отвечает только запросам со страницы карточки (Referer).
 */
export function startMock({ pdf, wall = false, cardCheck = false, site = '', apiReferer = false } = {}) {
  const hits = [];
  const setPdf = (b) => { pdf = b; };
  const setSite = (html) => { site = html; };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    if (wall) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>Проверка браузера. Подтвердите, что вы не робот.</body></html>');
    }
    if (u.pathname.startsWith('/Card/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(cardCheck && !passed(req) ? challenge(u.pathname) : CARD_HTML);
    }
    if (u.pathname === '/site/' && site) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(site);
    }
    if (u.pathname === '/Kad/InstanceDocumentsPage') {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') { res.writeHead(451); return res.end(); }
      if (apiReferer && !/\/Card\//.test(req.headers.referer || '')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ Success: false, Message: 'нет доступа' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(page(ITEMS, +u.searchParams.get('page') || 1)));
    }
    // PDF — как у kad: /Kad/PdfDocument/… уводит на /Document/Pdf/…?isAddStamp=True,
    // там страница проверки «salto»; файл — только на POST с верным hash.
    if (u.pathname.startsWith('/Kad/PdfDocument/') && pdf) {
      res.writeHead(302, { Location: u.pathname.replace('/Kad/PdfDocument/', '/Document/Pdf/') + '?isAddStamp=True' });
      return res.end();
    }
    if (u.pathname.startsWith('/Document/Pdf/') && pdf) {
      if (req.method === 'POST') {
        return readBody(req).then((b) => {
          const f = new URLSearchParams(b);
          if (f.get('hash') && f.get('hash') === hashOf(f.get('token'))) {
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            return res.end(pdf);
          }
          res.writeHead(403);
          res.end();
        });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      return res.end(saltoPage(String(Math.floor(Math.random() * 1e16))));
    }
    // Страница программы и pdf.js рядом с ней — как на Pages.
    if (u.pathname.startsWith('/site/') && site) {
      const file = { '/site/pdf.min.mjs': 'pdf.min.mjs', '/site/pdf.worker.min.mjs': 'pdf.worker.min.mjs' }[u.pathname];
      if (file) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(new URL(`../node_modules/pdfjs-dist/build/${file}`, import.meta.url)));
      }
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>Картотека арбитражных дел</body></html>');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    // Сайт — с другого адреса, чем «картотека»: localhost и 127.0.0.1 — разные источники.
    resolve({ base: `http://127.0.0.1:${server.address().port}`, siteBase: `http://localhost:${server.address().port}`, hits, setPdf, setSite, close: () => new Promise((r) => server.close(r)) });
  }));
}
