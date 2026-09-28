/*
 * Загрузка карточки дела и PDF судебных актов с kad.arbitr.ru.
 *
 * Почему через браузер, а не простым HTTP-запросом. Картотека отдаёт
 * хронологию скриптом уже после загрузки страницы и отсекает запросы без
 * браузерных cookies проверкой «вы не робот». Настоящий браузер (Chrome,
 * Edge или Chromium) проходит её так же, как у человека. Профиль браузера
 * хранится в папке .kad-profile, и cookies переживают перезапуск сервера:
 * если проверку однажды пришлось пройти вручную (режим с окном), второй
 * раз она обычно не нужна.
 *
 * Результат — текст. Либо записи картотеки из её собственного API,
 * переложенные в построчный вид с явными метками («В ответ на:», «PDF:»),
 * либо текст страницы, как если бы её скопировали Ctrl+A. Разбирает его
 * тот же src/kad.js, что и вставку, — ветка разбора одна.
 *
 * Картотеку не нагружаем: запросы идут по одному, с паузой, а тексты
 * судебных актов кэшируются на диске — они не меняются.
 */
import fs from 'fs';
import path from 'path';
import '../src/kad-items.js';

/* Записи API → текст: общий с расширением браузера модуль src/kad-items.js. */
export const itemsToText = (items, caseId) => globalThis.KadItems.itemsToText(items, caseId);

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MIN_GAP_MS = 2500;
const IDLE_CLOSE_MS = 3 * 60 * 1000;

let pw = null;
async function playwright() {
  if (pw) return pw;
  try {
    pw = await import('playwright-core');
  } catch (_) {
    throw new Error('не установлен пакет playwright-core — выполните npm install');
  }
  return pw;
}

export class KadFetcher {
  /**
   * profileDir — папка профиля браузера; headful — показывать окно (для
   * ручного прохождения проверки); browserPath — путь к chrome/msedge;
   * base — адрес картотеки (подменяется в тестах макетом).
   */
  constructor({ profileDir, headful = false, browserPath = '', base = 'https://kad.arbitr.ru', log = console.log } = {}) {
    this.profileDir = profileDir;
    this.headful = headful;
    this.browserPath = browserPath;
    this.base = base.replace(/\/$/, '');
    this.log = log;
    this.ctx = null;
    this.browserName = '';
    this.chain = Promise.resolve();
    this.lastAt = 0;
    this.idleTimer = null;
  }

  status() {
    return { running: !!this.ctx, browser: this.browserName || null, headful: this.headful };
  }

  /* Всё обращение к картотеке — строго по очереди и с паузой. */
  queue(job) {
    const run = async () => {
      const wait = this.lastAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await job(); } finally { this.lastAt = Date.now(); this.scheduleClose(); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  scheduleClose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async close() {
    clearTimeout(this.idleTimer);
    const c = this.ctx;
    this.ctx = null;
    if (c) await c.close().catch(() => {});
  }

  async context() {
    if (this.ctx) return this.ctx;
    const { chromium } = await playwright();
    fs.mkdirSync(this.profileDir, { recursive: true });
    const base = {
      headless: !this.headful,
      viewport: { width: 1366, height: 900 },
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      acceptDownloads: false,
      args: ['--disable-blink-features=AutomationControlled']
    };
    // Сначала браузер, указанный явно, затем установленные Chrome и Edge
    // (Edge есть в любой Windows), затем Chromium из playwright.
    const tries = this.browserPath
      ? [{ executablePath: this.browserPath }]
      : [{ channel: 'chrome' }, { channel: 'msedge' }, {}];
    let lastErr = null;
    for (const t of tries) {
      try {
        let ctx = await chromium.launchPersistentContext(this.profileDir, { ...base, ...t });
        // В режиме без окна браузер называет себя HeadlessChrome — такой
        // подпись картотека встречает проверкой. Перезапуск с обычной.
        const ua = await userAgent(ctx);
        if (/Headless/i.test(ua)) {
          await ctx.close();
          ctx = await chromium.launchPersistentContext(this.profileDir, { ...base, ...t, userAgent: ua.replace(/HeadlessChrome/g, 'Chrome') });
        }
        await ctx.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        ctx.on('close', () => { if (this.ctx === ctx) this.ctx = null; });
        this.ctx = ctx;
        this.browserName = t.channel || (t.executablePath ? path.basename(t.executablePath) : 'chromium');
        this.log(`браузер запущен: ${this.browserName}${this.headful ? ', с окном' : ''}`);
        return ctx;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('не удалось запустить браузер. Установите Google Chrome или Microsoft Edge, ' +
      'либо укажите путь к нему в переменной KAD_BROWSER, либо выполните «npx playwright install chromium». ' +
      `Последняя ошибка: ${String(lastErr && lastErr.message || lastErr).split('\n')[0]}`);
  }

  /**
   * Карточка дела → { pageText, apiText, apiItems, caseId, at }.
   * Какой из двух текстов лучше, решает вызывающий код: он же их и разбирает.
   */
  card(url) {
    return this.queue(async () => {
      const caseId = (url.match(GUID_RE) || [''])[0];
      const target = this.base === 'https://kad.arbitr.ru' ? url : `${this.base}/Card/${caseId}`;
      const ctx = await this.context();
      const page = await ctx.newPage();
      const captured = [];
      page.on('response', async (res) => {
        if (!/DocumentsPage|\/Kad\/CaseDocuments|\/Kad\/InstanceDocuments/i.test(res.url())) return;
        try { captured.push({ url: res.url(), data: await res.json() }); } catch (_) { /* не JSON */ }
      });
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await settle(page);
        await this.passChallenge(page);
        await expand(page);
        await settle(page);

        const items = await collectItems(page, captured, caseId);
        let pageText = await textOf(page);
        // Ссылки в тексте — всегда на kad.arbitr.ru, даже если страницу
        // отдал макет в тестах: по ним потом запрашиваются PDF.
        if (this.base !== 'https://kad.arbitr.ru') pageText = pageText.split(this.base).join('https://kad.arbitr.ru');
        return {
          caseId,
          at: new Date().toISOString(),
          pageText,
          apiItems: items.length,
          apiText: items.length ? itemsToText(items, caseId) : '',
          // Для диагностики (tools/kad-probe.mjs): что именно отдал API.
          apiRaw: items,
          apiUrls: captured.map((c) => c.url)
        };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /**
   * Страница проверки вместо карточки. Без окна её не пройти — объясняем,
   * что делать; с окном ждём, пока человек её пройдёт.
   */
  async passChallenge(page) {
    const deadline = Date.now() + (this.headful ? 180000 : 25000);
    for (;;) {
      const s = await page.evaluate(() => ({
        text: (document.body && document.body.innerText || '').slice(0, 4000),
        title: document.title
      })).catch(() => ({ text: '', title: '' }));
      const isCard = /[АA]\d{1,3}-\d{1,7}\/\d{4}/.test(s.text) || /Карточка|хронолог/i.test(s.text);
      const isWall = /робот|captcha|капч|провер[а-яё]+ браузер|подозрительн|доступ (?:ограничен|запрещ)|access denied|forbidden/i.test(s.text + ' ' + s.title);
      if (isCard && !isWall) return;
      if (Date.now() > deadline) {
        if (isWall) {
          throw new Error(this.headful
            ? 'проверка «вы не робот» не пройдена за 3 минуты'
            : 'kad.arbitr показал проверку «вы не робот». Запустите сервер с окном браузера (npm run start:window), пройдите проверку в открывшемся окне, и дальше загрузка пойдёт сама');
        }
        if (!s.text.trim()) throw new Error('kad.arbitr вернул пустую страницу — попробуйте позже');
        return;  // не карточка и не проверка: пусть решает разбор
      }
      await page.waitForTimeout(1500);
    }
  }

  /**
   * PDF судебного акта → Buffer.
   *
   * На прямой запрос картотека отвечает не файлом, а страницей-проверкой:
   * скрипт решает задачку, получает cookies и перенаправляет на
   * /Document/Pdf/…?isAddStamp=True. Поэтому: прямой запрос; не вышло —
   * вкладка проходит проверку и называет адрес файла; файл — снова прямым
   * запросом, уже с cookies. Тело ответа из самой вкладки не берётся: PDF в
   * ней открывает встроенный просмотрщик, и ответ может не отдаться никогда.
   */
  pdf(url) {
    return this.queue(async () => {
      const ctx = await this.context();
      const target = this.base === 'https://kad.arbitr.ru' ? url : url.replace(/^https?:\/\/kad\.arbitr\.ru/i, this.base);
      const direct = async (u) => {
        const res = await ctx.request.get(u, { timeout: 60000, headers: { Referer: `${this.base}/` } }).catch(() => null);
        if (!res || !res.ok()) return null;
        const buf = await res.body().catch(() => null);
        return isPdf(buf) ? buf : null;
      };
      let buf = await direct(target);
      if (buf) return buf;

      // Вкладка: проверка картотеки проходит сама, а PDF перехватывается на
      // уровне сети браузера (протокол DevTools, Fetch.getResponseBody) — до
      // встроенного просмотрщика, из которого тело ответа не достать.
      const page = await ctx.newPage();
      let pdfUrl = null;
      try {
        const cdp = await ctx.newCDPSession(page);
        const got = new Promise((resolve) => {
          cdp.on('Fetch.requestPaused', async (ev) => {
            try {
              const ct = (ev.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
              if (ev.responseStatusCode === 200 && ct && /pdf/i.test(ct.value)) {
                pdfUrl = ev.request.url;
                const body = await cdp.send('Fetch.getResponseBody', { requestId: ev.requestId });
                const b = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
                if (isPdf(b)) resolve(b);
              }
            } catch (_) { /* ответ без тела */ }
            cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
          });
        });
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
        await page.goto(target, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
        buf = await Promise.race([got, wait(45000)]);
        await cdp.send('Fetch.disable').catch(() => {});
        if (isPdf(buf)) return buf;
      } finally {
        await Promise.race([page.close().catch(() => {}), wait(5000)]);
      }

      // Запасной путь: запрос из страницы картотеки — с теми же cookies и
      // заголовками браузера, что прошли проверку.
      if (pdfUrl) {
        buf = await direct(pdfUrl);
        if (buf) return buf;
        const kad = await ctx.newPage();
        try {
          await kad.goto(`${this.base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          const b64 = await kad.evaluate(async (u) => {
            const r = await fetch(u, { credentials: 'include' });
            const bytes = new Uint8Array(await r.arrayBuffer());
            let s = '';
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return btoa(s);
          }, pdfUrl).catch(() => '');
          buf = b64 ? Buffer.from(b64, 'base64') : null;
          if (isPdf(buf)) return buf;
        } finally {
          await Promise.race([kad.close().catch(() => {}), wait(5000)]);
        }
      }
      throw new Error(pdfUrl
        ? 'проверка картотеки пройдена, но PDF получить не удалось'
        : 'картотека не пропустила к PDF за 45 секунд — документ ещё не опубликован или проверка не пройдена');
    });
  }
}

const wait = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
const isPdf = (buf) => buf && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

async function userAgent(ctx) {
  const p = ctx.pages()[0] || await ctx.newPage();
  const ua = await p.evaluate(() => navigator.userAgent).catch(() => '');
  return ua;
}

/* Дождаться, пока страница догрузит хронологию. */
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/**
 * Раскрыть свёрнутое: инстанции и «показать ещё». Классы картотеки
 * неизвестны заранее и меняются, поэтому — по смыслу: кнопки и ссылки,
 * которые никуда не уводят, с текстом «показать/развернуть/ещё», и
 * заголовки инстанций с пустым списком документов.
 */
async function expand(page) {
  for (let round = 0; round < 6; round++) {
    const clicked = await page.evaluate(() => {
      const TEXT = /^(?:показать\s+(?:ещё|еще|все|полностью)|ещё|еще|развернуть|все\s+документы|загрузить\s+ещё)/i;
      const out = [];
      const els = document.querySelectorAll('a, button, span[role=button], div[role=button], [class*="collapse"], [class*="chrono-item-header"], [class*="more"]');
      for (const el of els) {
        if (el.dataset.kadClicked) continue;
        const href = el.getAttribute && el.getAttribute('href');
        if (href && !/^(#|javascript:)/i.test(href)) continue;
        const t = (el.innerText || '').trim();
        const header = /chrono-item-header|collapse/.test(el.className || '') && !/expanded|opened|active/.test(el.className || '');
        if (!TEXT.test(t) && !header) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        el.dataset.kadClicked = '1';
        el.click();
        out.push(t.slice(0, 30));
        if (out.length >= 15) break;
      }
      window.scrollTo(0, document.body.scrollHeight);
      return out.length;
    }).catch(() => 0);
    if (!clicked) break;
    await settle(page);
  }
}

/** Текст страницы; ссылки на PDF — отдельными строками «PDF: …». */
async function textOf(page) {
  return page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href*="/Document/Pdf/"], a[href*="/PdfDocument/"]')) {
      const div = document.createElement('div');
      div.textContent = 'PDF: ' + a.href;
      a.after(div);
    }
    return document.body ? document.body.innerText : '';
  });
}

/* ---------- записи из API картотеки ---------- */

/** Массив записей в ответе API, где бы он ни лежал. */
function findItems(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.Result && Array.isArray(data.Result.Items)) return data.Result.Items;
  if (Array.isArray(data.Items)) return data.Items;
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && Object.keys(v[0]).some((k) => /date/i.test(k))) return v;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = findItems(v);
      if (inner) return inner;
    }
  }
  return null;
}

function pagesOf(data) {
  const r = (data && (data.Result || data)) || {};
  if (r.PagesCount) return +r.PagesCount;
  if (r.TotalCount && r.PageSize) return Math.ceil(r.TotalCount / r.PageSize);
  return 1;
}

/**
 * Все записи: то, что страница уже запросила сама, плюс остальные
 * страницы тех же запросов. Если сама она не запросила ничего — пробуем
 * список «Электронного дела» по номеру карточки.
 */
async function collectItems(page, captured, caseId) {
  const seen = new Map();
  const add = (list) => {
    for (const it of list || []) {
      const key = it.Id || it.id || JSON.stringify(it).slice(0, 300);
      if (!seen.has(key)) seen.set(key, it);
    }
  };

  const fetchJson = (u) => page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*' } });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }, u).catch(() => null);

  if (!captured.length && caseId) {
    const u = `/Kad/CaseDocumentsPage?_=${Date.now()}&caseId=${caseId}&page=1&perPage=25`;
    const data = await fetchJson(u);
    if (findItems(data)) captured.push({ url: new URL(u, page.url()).href, data });
  }

  const done = new Set();
  for (const c of [...captured]) {
    add(findItems(c.data));
    const u = new URL(c.url);
    u.searchParams.delete('_');
    u.searchParams.delete('page');
    const key = u.toString();
    if (done.has(key)) continue;
    done.add(key);
    const pages = Math.min(pagesOf(c.data), 200);
    for (let p = 2; p <= pages; p++) {
      u.searchParams.set('page', String(p));
      u.searchParams.set('_', String(Date.now()));
      const data = await fetchJson(u.toString());
      const list = findItems(data);
      if (!list || !list.length) break;
      add(list);
      await page.waitForTimeout(400);
    }
  }
  return [...seen.values()];
}
