/*
 * Проба: можно ли получать карточку kad.arbitr без браузера — обычными
 * HTTP-запросами (как это делал бы маленький прокси-сервер), и не разрешает
 * ли картотека сайтам читать свои ответы (CORS, JSONP).
 *
 * Проверки картотеки — скрипты в её же страницах — выполняются в jsdom.
 * Печатает только устройство ответов, да/нет и числа; содержание карточки
 * и PDF не печатается. Код проверок картотеки (не данные дела) печатается
 * с замаскированными длинными значениями.
 *
 * node tools/http-probe.mjs <ссылка на карточку>   (нужен jsdom: npm i --no-save jsdom)
 */
const [card] = process.argv.slice(2);
const caseId = card.match(/[0-9a-f-]{36}/i)[0];
const KAD = process.env.KAD_BASE || 'https://kad.arbitr.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const { JSDOM, CookieJar, VirtualConsole } = await import('jsdom');

const jar = new CookieJar();
const anon = (s) => String(s || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>').replace(/[^/?=&"' ]+\.pdf/gi, '<файл>.pdf');
const mask = (s) => anon(s).replace(/[A-Za-z0-9+/=_-]{24,}/g, (m) => `<${m.length}>`);
const log = (k, v) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const isPdf = (b) => b.length > 4 && b.subarray(0, 5).toString() === '%PDF-';

/* Запрос с cookies и переходами вручную — как браузер, но без него. */
async function req(url, opts = {}, hops = 0) {
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'ru-RU,ru;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...opts.headers
  };
  const cookie = jar.getCookieStringSync(url);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body, redirect: 'manual' });
  for (const c of res.headers.getSetCookie()) jar.setCookieSync(c, url, { ignoreError: true });
  if ([301, 302, 303, 307, 308].includes(res.status) && hops < 6) {
    const to = new URL(res.headers.get('location'), url).href;
    return req(to, res.status === 303 || res.status === 302 ? { headers: opts.headers } : opts, hops + 1);
  }
  const body = Buffer.from(await res.arrayBuffer());
  return { res, body, url, text: () => body.toString('utf8') };
}

const brief = (r) => ({ status: r.res.status, type: r.res.headers.get('content-type'), len: r.body.length, url: anon(r.url.replace(KAD, '')) });
const cookieNames = () => jar.getCookiesSync(KAD).map((c) => c.key);

/* Скрытые поля с кодом, записанным табуляциями и пробелами (как у «salto»). */
function decodedScripts(html) {
  const out = [];
  for (const m of html.matchAll(/value="([\t \n]{40,})"/g)) {
    const code = m[1].split('\n').map((l) => String.fromCharCode(parseInt([...l].map((c) => (c === '\t' ? '1' : '0')).join(''), 2))).join('');
    out.push(code.slice(0, -1));
  }
  return out;
}

/*
 * Выполнить проверку картотеки в jsdom: отправку формы перехватить, переход
 * и cookies — записать. → { form, nav, cookies }.
 */
async function solve(html, url, ms = 15000) {
  const vc = new VirtualConsole();
  const notes = [];
  vc.on('jsdomError', (e) => notes.push(String(e.message).slice(0, 120)));
  let form = null;
  let nav = null;
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', pretendToBeVisual: true, cookieJar: jar, virtualConsole: vc,
    beforeParse(w) {
      const grab = (f) => { form = { action: f.getAttribute('action') || '', method: f.method, body: new w.URLSearchParams(new w.FormData(f)).toString() }; };
      w.HTMLFormElement.prototype.submit = function () { grab(this); };
      w.HTMLFormElement.prototype.requestSubmit = function () { grab(this); };
      w.addEventListener('submit', (e) => { e.preventDefault(); grab(e.target); }, true);
      Object.defineProperty(w.navigator, 'webdriver', { get: () => false });
    }
  });
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !form) {
    await new Promise((ok) => setTimeout(ok, 200));
    const m = notes.find((n) => /navigation/i.test(n));
    if (m) { nav = m; break; }
  }
  dom.window.close();
  return { form, nav, notes: notes.slice(0, 5), ms: Date.now() - t0, cookies: cookieNames() };
}

try {
  // 1. Разрешает ли картотека чужим сайтам читать ответы.
  const api1 = `${KAD}/Kad/InstanceDocumentsPage?id=00000000-0000-0000-0000-000000000000&caseId=${caseId}&perPage=30&page=1`;
  const acao = (r) => Object.fromEntries([...r.res.headers].filter(([k]) => /^access-control-/i.test(k)));
  const pre = await req(api1, { method: 'OPTIONS', headers: { Origin: 'https://okbl.github.io', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-requested-with' } });
  log('CORS: предварительный запрос к API', { status: pre.res.status, headers: acao(pre) });
  const g = await req(api1, { headers: { Origin: 'https://okbl.github.io', 'X-Requested-With': 'XMLHttpRequest' } });
  log('CORS: запрос к API с чужого сайта', { ...brief(g), headers: acao(g) });
  const gc = await req(card, { headers: { Origin: 'https://okbl.github.io' } });
  log('CORS: карточка с чужого сайта', { ...brief(gc), headers: acao(gc) });
  const jp = await req(`${api1}&callback=cb`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  log('JSONP (callback=)', { ...brief(jp), starts: jp.text().slice(0, 12).replace(/\s+/g, ' ') });

  // 2. Карточка без браузера.
  const c1 = await req(card);
  const h1 = c1.text();
  const inst1 = (h1.match(/js-instanceId/g) || []).length;
  log('карточка, первый запрос', { ...brief(c1), instances: inst1, cookies: cookieNames(), server: c1.res.headers.get('server') });
  if (!inst1) {
    log('страница проверки перед карточкой', mask(h1).replace(/\s+/g, ' ').slice(0, 2500));
    decodedScripts(h1).forEach((code, i) => log(`её скрипт ${i + 1} (раскодирован)`, mask(code).slice(0, 4000)));
    const s1 = await solve(h1, card);
    log('проверка перед карточкой в jsdom', { form: s1.form && { action: anon(s1.form.action), fields: [...new URLSearchParams(s1.form.body).keys()] }, nav: s1.nav, notes: s1.notes, ms: s1.ms, cookies: s1.cookies });
    if (s1.form) {
      const target = new URL(s1.form.action || card, card).href;
      const p = await req(target, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: card }, body: s1.form.body });
      log('отправка формы проверки', { ...brief(p), instances: (p.text().match(/js-instanceId/g) || []).length });
    }
  }
  const c2 = await req(card);
  const h2 = c2.text();
  const ids = [...h2.matchAll(/<input\b[^>]*\bjs-instanceId\b[^>]*>/gi)].map((m) => (m[0].match(/value="([^"]+)"/) || [])[1]).filter(Boolean);
  log('карточка, повторный запрос', { ...brief(c2), instances: ids.length, cookies: cookieNames() });

  // 3. API хронологии без браузера.
  if (ids.length) {
    let items = 0;
    let pages = null;
    let pdf = null;
    for (let page = 1; page <= 10; page++) {
      const a = await req(`${KAD}/Kad/InstanceDocumentsPage?_=${Date.now()}&id=${ids[0]}&caseId=${caseId}&perPage=30&page=${page}`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', Referer: card } });
      let j = null;
      try { j = JSON.parse(a.text()); } catch (_) { j = null; }
      if (page === 1) log('API хронологии, стр. 1', { ...brief(a), json: !!j, items: j && j.Result && j.Result.Items ? j.Result.Items.length : -1, pages: j && j.Result && j.Result.PagesCount });
      if (!j || !j.Result || !j.Result.Items || !j.Result.Items.length) break;
      items += j.Result.Items.length;
      pages = j.Result.PagesCount;
      pdf = pdf || j.Result.Items.find((x) => x.FileName);
      if (page >= pages) break;
      await new Promise((ok) => setTimeout(ok, 300));
    }
    log('API хронологии, всего', { items, pages });

    // 4. PDF без браузера: проверка «salto» в jsdom, форма — запросом.
    if (pdf) {
      const u = `${KAD}/Kad/PdfDocument/${caseId}/${pdf.Id}/${pdf.FileName}`;
      let d = await req(u, { headers: { Referer: card } });
      for (let i = 0; i < 3 && [502, 503, 504].includes(d.res.status); i++) {
        await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
        d = await req(u, { headers: { Referer: card } });
      }
      log('PDF, первый запрос', { ...brief(d), pdf: isPdf(d.body) });
      if (!isPdf(d.body)) {
        decodedScripts(d.text()).forEach((code, i) => log(`проверка перед PDF, скрипт ${i + 1} (раскодирован)`, mask(code).slice(0, 4000)));
        const s2 = await solve(d.text(), d.url);
        log('проверка перед PDF в jsdom', { form: s2.form && { fields: [...new URLSearchParams(s2.form.body).keys()] }, nav: s2.nav, notes: s2.notes, ms: s2.ms });
        if (s2.form) {
          const p = await req(d.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: d.url }, body: s2.form.body });
          log('PDF после проверки', { ...brief(p), pdf: isPdf(p.body) });
        }
      }
    }
  }
} catch (e) {
  console.log('ОШИБКА:', e.message.split('\n')[0]);
  process.exitCode = 1;
}
