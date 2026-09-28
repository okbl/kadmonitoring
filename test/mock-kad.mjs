/*
 * Макет kad.arbitr.ru для проверки загрузчика: настоящая картотека из среды
 * разработки недоступна. Макет повторяет то, на что опирается загрузчик, а
 * не вёрстку картотеки: карточка догружает хронологию скриптом из JSON API
 * постранично, записи ссылаются друг на друга, акты лежат в PDF.
 *
 * Страница показывает только первую страницу хронологии — остальное
 * загрузчик должен добрать из API сам.
 */
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
<h1>А40-123456/2025</h1>
<div>Дело о несостоятельности (банкротстве) гражданина</div>
<div>Арбитражный суд города Москвы</div>
<div>Должник: Иванов Иван Иванович</div>
<h2>Первая инстанция</h2>
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

/**
 * pdf — Buffer с PDF, который отдаётся на любой /Document/Pdf/…;
 * wall — показывать страницу проверки вместо карточки.
 */
export function startMock({ pdf, wall = false } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    if (wall) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>Проверка браузера. Подтвердите, что вы не робот.</body></html>');
    }
    if (u.pathname.startsWith('/Card/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(CARD_HTML);
    }
    if (u.pathname === '/Kad/InstanceDocumentsPage') {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') { res.writeHead(451); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(page(ITEMS, +u.searchParams.get('page') || 1)));
    }
    if (/^\/(?:Document\/Pdf|Kad\/PdfDocument)\//.test(u.pathname) && pdf) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(pdf);
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>Картотека арбитражных дел</body></html>');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ base: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) });
  }));
}
