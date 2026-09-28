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
   * PDF судебного акта → Buffer. Сначала запросом от имени браузера (cookies
   * общие), а если картотека ответила не PDF — из самой страницы картотеки.
   */
  pdf(url) {
    return this.queue(async () => {
      const ctx = await this.context();
      const target = this.base === 'https://kad.arbitr.ru' ? url : url.replace(/^https?:\/\/kad\.arbitr\.ru/i, this.base);
      const res = await ctx.request.get(target, { timeout: 60000, headers: { Referer: `${this.base}/` } }).catch(() => null);
      if (res && res.ok()) {
        const buf = await res.body();
        if (isPdf(buf)) return buf;
      }
      const page = await ctx.newPage();
      try {
        await page.goto(`${this.base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.passChallenge(page).catch(() => {});
        const b64 = await page.evaluate(async (u) => {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) return 'ERR' + r.status;
          const bytes = new Uint8Array(await r.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(s);
        }, target);
        if (b64.startsWith('ERR')) throw new Error(`kad.arbitr ответил ${b64.slice(3)}`);
        const buf = Buffer.from(b64, 'base64');
        if (!isPdf(buf)) throw new Error('вместо PDF пришла страница — документ ещё не опубликован или требуется проверка');
        return buf;
      } finally {
        await page.close().catch(() => {});
      }
    });
  }
}

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

const pick = (o, re) => {
  for (const [k, v] of Object.entries(o || {})) if (re.test(k) && v != null && v !== '') return v;
  return null;
};

/** «/Date(1719100800000)/», ISO или «23.06.2026» → «23.06.2026». */
function ruDate(v) {
  if (!v) return '';
  const s = String(v);
  let m = s.match(/^\d{1,2}\.\d{1,2}\.\d{4}/);
  if (m) return m[0];
  m = s.match(/\/Date\((-?\d+)/);
  const d = m ? new Date(+m[1]) : /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s) : null;
  if (!d || isNaN(d)) return '';
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);  // даты картотеки — московские
  return `${String(msk.getUTCDate()).padStart(2, '0')}.${String(msk.getUTCMonth() + 1).padStart(2, '0')}.${msk.getUTCFullYear()}`;
}

const names = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  .map((x) => typeof x === 'string' ? x : (x && (x.Organization || x.Name || x.Fio || x.FullName || x.ShortName || x.Title)) || '')
  .filter(Boolean);

/** Любая строка внутри записи, начинающаяся с «В ответ на». */
function deepFind(o, re, depth = 0) {
  if (depth > 3 || !o) return null;
  if (typeof o === 'string') return re.test(o) ? o : null;
  if (typeof o !== 'object') return null;
  for (const v of Object.values(o)) {
    const hit = deepFind(v, re, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Записи API → построчный текст с явными метками. Имена полей картотеки
 * документированы только её вёрсткой, поэтому поля ищутся по смыслу имени,
 * а не по точному совпадению: Date/DisplayDate, DocumentTypeName, ContentTypes…
 */
export function itemsToText(items, caseId, base = 'https://kad.arbitr.ru') {
  const byId = new Map(items.map((it) => [String(it.Id || it.id || ''), it]));
  const blocks = [];
  const sorted = [...items].sort((a, b) => {
    const da = ruDate(pick(a, /^(?:DisplayDate|Date|RegDate|DocumentDate)$/i)).split('.').reverse().join('');
    const db = ruDate(pick(b, /^(?:DisplayDate|Date|RegDate|DocumentDate)$/i)).split('.').reverse().join('');
    return da < db ? -1 : da > db ? 1 : 0;
  });
  for (const it of sorted) {
    if (it.IsDeleted) continue;
    const date = ruDate(pick(it, /^(?:DisplayDate|Date|RegDate|DocumentDate|RegistrationDate)$/i) || pick(it, /date/i));
    if (!date) continue;
    const type = pick(it, /^(?:DocumentTypeName|DocumentType|TypeName|DocType)$/i) || 'Документ';
    const content = pick(it, /^(?:ContentTypes|ContentTypeName|ContentType|Content|Subject)$/i);
    const contentText = Array.isArray(content) ? content.map((x) => typeof x === 'string' ? x : x && (x.Name || x.Title) || '').filter(Boolean).join('; ') : (typeof content === 'string' ? content : '');
    const lines = [date, String(type)];
    if (contentText) lines.push(contentText);
    const from = names(pick(it, /^(?:Declarers|Declarer|Applicants|Applicant|Participants|Sides)$/i));
    if (from.length) lines.push(`Подал: ${from.join(', ')}`);
    const judges = names(pick(it, /^(?:Judges|Judge|JudgeName)$/i));
    if (judges.length) lines.push(`Судья: ${judges.join(', ')}`);
    const id = String(it.Id || it.id || '');
    if (GUID_RE.test(id)) lines.push(`Документ: ${id.match(GUID_RE)[0]}`);

    // Картотека пишет связь и заседание в AdditionalInfo одной строкой:
    // «Штрихкод: 0031739831 В ответ на Заявление (23.06.2026) от ПАО …,
    // Дата и время судебного заседания 15.09.2026, 10:00, зал № 602».
    let info = String(pick(it, /^AdditionalInfo$/i) || '').replace(/штрихкод:?\s*\d+/i, '').trim();
    let hearingText = '';
    const hm = info.match(/,?\s*дата\s+и\s+время\s+(?:судебного\s+)?заседания[:\s]*(.+)$/i);
    if (hm) { hearingText = hm[1].trim(); info = info.slice(0, hm.index).trim(); }
    let reasonText = '';
    const rm = info.match(/в\s+ответ\s+на[:\s]*(.+)$/i);
    if (rm) { reasonText = rm[1].replace(/[,;]\s*$/, '').trim(); info = info.slice(0, rm.index).trim(); }
    if (!reasonText) {
      const deep = deepFind(it, /в\s+ответ\s+на/i);
      if (deep) reasonText = deep.replace(/^[\s\S]*?в\s+ответ\s+на[:\s]*/i, '').trim();
    }

    // Ссылка на документ точнее любого сравнения по дате, а текст нужен
    // человеку и тем записям, у которых ссылки нет.
    const reasonId = pick(it, /(?:Reason|Parent|Answer|Response|Basis)(?:Document)?Id$/i);
    if (reasonText) {
      lines.push(`В ответ на: ${reasonText}`);
    } else if (reasonId && byId.has(String(reasonId))) {
      const ref = byId.get(String(reasonId));
      const rType = pick(ref, /^(?:DocumentTypeName|DocumentType|TypeName)$/i) || 'Документ';
      const rFrom = names(pick(ref, /^(?:Declarers|Declarer|Applicants)$/i)).join(', ');
      lines.push(`В ответ на: ${rType} (${ruDate(pick(ref, /^(?:DisplayDate|Date)$/i))})${rFrom ? ` от ${rFrom}` : ''}`);
    }
    if (reasonId && GUID_RE.test(String(reasonId))) lines.push(`Ответ на документ: ${String(reasonId).match(GUID_RE)[0]}`);

    const hearing = pick(it, /^(?:HearingDate|HearingDateTime|SessionDate)$/i);
    if (hearingText) {
      lines.push(`Дата и время судебного заседания: ${hearingText}`);
    } else if (hearing) {
      const place = pick(it, /^(?:HearingPlace|SessionPlace|Place)$/i);
      const t = String(hearing).match(/\/Date\((-?\d+)/)
        ? (() => { const d = new Date(+String(hearing).match(/\/Date\((-?\d+)/)[1] + 3 * 3600 * 1000); return `${ruDate(hearing)}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; })()
        : String(hearing);
      lines.push(`Дата и время судебного заседания: ${t}${place ? `, ${place}` : ''}`);
    }
    const comment = pick(it, /^(?:Comment|Description|Note)$/i);
    for (const extra of [info, typeof comment === 'string' ? comment : '']) {
      if (extra && extra.trim()) lines.push(extra.trim().replace(/\s+/g, ' '));
    }
    const pub = pick(it, /^(?:PublishDisplayDate|PublishDate|PublicationDate)$/i);
    if (pub) lines.push(`Публикация: ${/\/Date\(/.test(pub) ? ruDate(pub) : pub}`);
    // Срок обжалования, который считает сама картотека.
    const appeal = pick(it, /^AppealDate$/i);
    if (appeal) lines.push(`Обжалование до: ${ruDate(appeal)}`);

    const file = pick(it, /^(?:FileName|File)$/i);
    const docCase = String(it.CaseId || caseId || '');
    if (file && id && docCase) lines.push(`PDF: ${base}/Kad/PdfDocument/${docCase}/${id}/${encodeURIComponent(String(file))}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}
