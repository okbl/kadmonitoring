/*
 * Локальный сервер отслеживания обособленных споров.
 *
 * Что делает сверх страницы с диска:
 *   — загружает карточку дела по ссылке (через браузер, см. server/kad-fetch.mjs);
 *   — достаёт текст определений из PDF картотеки;
 *   — хранит отслеживаемые споры в data/disputes и перепроверяет их по
 *     расписанию, отмечая новые документы спора; по желанию шлёт о них
 *     сообщение в Telegram.
 *
 * Разбор и правила — те же модули src/, что работают в браузере: сервер
 * считает ими сводку для списка споров и отбирает акты, чей текст нужен.
 *
 * Запуск: npm start (браузер без окна) или npm run start:window (с окном —
 * если картотека попросит пройти проверку «вы не робот»).
 *
 * Слушает только 127.0.0.1: это инструмент одного компьютера, паролей у
 * него нет. HOST=0.0.0.0 открывает его в локальной сети — на свой риск.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { assemble } from './build.mjs';
import { KadFetcher } from './server/kad-fetch.mjs';
import { pdfText } from './server/pdf-text.mjs';
import './src/kad-items.js';
import './src/dates.js';
import './src/kad.js';
import './src/rules.js';
import './src/dispute.js';

const { KadCard, KadDispute, KadDates } = globalThis;

const root = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = +(env.PORT || 8080);
const HOST = env.HOST || '127.0.0.1';
const DATA = path.resolve(env.KAD_DATA || path.join(root, 'data'));
const CHECK_HOURS = env.KAD_CHECK_HOURS !== undefined && env.KAD_CHECK_HOURS !== '' ? +env.KAD_CHECK_HOURS : 12;
const HEADFUL = process.argv.includes('--window') || /^(1|true|yes)$/i.test(env.KAD_WINDOW || '');
const TELEGRAM = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
  ? { token: env.TELEGRAM_BOT_TOKEN, chat: env.TELEGRAM_CHAT_ID } : null;

const DIR = path.join(DATA, 'disputes');
const PDF_CACHE = path.join(DATA, 'pdf-text');
const ID_RE = /^[a-f0-9]{12}$/;
const KAD_CARD = new RegExp(`^https?://(?:www\\.)?kad\\.arbitr\\.ru/Card/${KadCard.GUID}`, 'i');
const KAD_PDF = /^https?:\/\/(?:www\.)?kad\.arbitr\.ru\/(?:Document\/Pdf|Kad\/PdfDocument)\//i;

const log = (...a) => console.log(new Date().toLocaleString('ru-RU'), '·', ...a);

const fetcher = new KadFetcher({
  profileDir: path.resolve(env.KAD_PROFILE || path.join(root, '.kad-profile')),
  headful: HEADFUL,
  browserPath: env.KAD_BROWSER || '',
  base: env.KAD_BASE || 'https://kad.arbitr.ru',
  log
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- хранение ---------- */

function fileOf(id) {
  if (!ID_RE.test(String(id))) throw new HttpError(404, 'нет такого спора');
  return path.join(DIR, `${id}.json`);
}

function load(id) {
  const f = fileOf(id);
  if (!fs.existsSync(f)) throw new HttpError(404, 'нет такого спора');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function store(st) {
  fs.mkdirSync(DIR, { recursive: true });
  const f = fileOf(st.id);
  fs.writeFileSync(f + '.tmp', JSON.stringify(st), 'utf8');
  fs.renameSync(f + '.tmp', f);
}

function allIds() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => /^[a-f0-9]{12}\.json$/.test(f)).map((f) => f.slice(0, 12));
}

/* Поля, которые ведёт сервер: страница их не присылает и не затирает. */
const SERVER_FIELDS = ['id', 'createdAt', 'checkedAt', 'error', 'note', 'notified'];

function clean(body) {
  const st = { ...body };
  delete st.summary;
  for (const k of SERVER_FIELDS) delete st[k];
  st.app = 'kadmonitoring';
  return st;
}

/* ---------- анализ тем же кодом, что в браузере ---------- */

const summaries = new Map();   // id → { stamp, summary }

function analyze(st) {
  const card = st.card && st.card.raw
    ? KadCard.parse(st.card.raw, { html: st.card.html })
    : { meta: {}, records: [], diagnostics: {} };
  const d = KadDispute.build(card, {
    filedDate: st.filed, applicant: st.applicant, role: st.role, hearing: st.hearing, subject: st.subject,
    texts: st.texts || {}, rootId: st.rootId, include: st.include, exclude: st.exclude, known: st.known
  });
  return { card, d, summary: { ...KadDispute.summary(d), debtor: card.meta.debtor || '' } };
}

function summaryOf(id, st) {
  const stamp = `${st.savedAt}|${st.checkedAt}|${(st.card && st.card.at) || ''}|${KadDates.today()}`;
  const c = summaries.get(id);
  if (c && c.stamp === stamp) return c.summary;
  let summary;
  try { summary = analyze(st).summary; } catch (e) { summary = { stageLabel: 'ошибка разбора', tone: 'bad', error: e.message }; }
  summaries.set(id, { stamp, summary });
  return summary;
}

/* Когда карточка в последний раз приходила с kad.arbitr — по кнопке или по плану. */
const lastCheck = (st) => st.checkedAt || (st.card && st.card.source === 'kad.arbitr' && st.card.at) || null;

const isAct = (e) => !e.rec.synthetic && /^(?:ruling|decision|appealRuling|protocol|courtDoc)$/.test(e.cls.nature || '');

/* ---------- обращение к картотеке ---------- */

async function fetchCard(url) {
  try {
    const r = await fetcher.card(url);
    return { ...globalThis.KadItems.chooseText(r, url), at: r.at };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(e.status || 502, e.message);
  }
}

/* Тексты судебных актов не меняются — кэш на диске бережёт картотеку. */
async function pdfTextCached(url) {
  const key = crypto.createHash('sha1').update(url.replace(/[?#].*$/, '')).digest('hex');
  const f = path.join(PDF_CACHE, `${key}.txt`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  let buf;
  try { buf = await fetcher.pdf(url); } catch (e) { throw new HttpError(502, e.message); }
  const text = await pdfText(buf);
  fs.mkdirSync(PDF_CACHE, { recursive: true });
  if (text) fs.writeFileSync(f, text, 'utf8');
  return text;
}

/**
 * Проверка спора: свежая карточка, тексты новых актов, отметка о новых
 * документах. why — 'plan' для плановой проверки, иначе — по кнопке.
 */
async function refresh(id, why) {
  const st = load(id);
  if (!KAD_CARD.test(st.url || '')) throw new HttpError(400, 'у спора нет ссылки на карточку kad.arbitr');
  try {
    const got = await fetchCard(st.url);
    const card = { raw: got.text, html: false, source: 'kad.arbitr', at: got.at };
    const texts = { ...(st.texts || {}) };
    let a = analyze({ ...st, card, texts });
    const acts = a.d.events.filter((e) => isAct(e) && e.rec.pdf && !texts[e.rec.id]).slice(0, 8);
    for (const e of acts) {
      try {
        const t = await pdfTextCached(e.rec.pdf);
        if (t) texts[e.rec.id] = t;
      } catch (err) {
        log(`текст акта от ${KadDates.fmt(e.rec.date)} не загружен: ${err.message}`);
      }
    }
    // Пока шла проверка, страница могла сохранить правки — берём свежую копию.
    const cur = load(id);
    cur.card = card;
    cur.texts = { ...texts, ...(cur.texts || {}) };
    cur.checkedAt = new Date().toISOString();
    cur.error = null;
    cur.note = got.note;
    a = analyze(cur);
    const fresh = a.d.events.filter((e) => e.isNew && !(cur.notified || []).includes(e.rec.id));
    if (fresh.length) cur.notified = [...(cur.notified || []), ...fresh.map((e) => e.rec.id)].slice(-500);
    store(cur);
    await report(cur, a, fresh, why);
    return { id, summary: a.summary, note: got.note, fresh: fresh.length };
  } catch (err) {
    const cur = load(id);
    cur.checkedAt = new Date().toISOString();
    cur.error = String(err.message).slice(0, 300);
    store(cur);
    throw err;
  }
}

async function report(st, a, fresh, why) {
  const s = a.summary;
  const title = `${s.caseNo || 'дело'}, заявление от ${KadDates.fmt(st.filed)}`;
  if (!fresh.length) {
    log(`${title}: новых документов нет (${s.stageLabel})`);
    return;
  }
  const lines = [
    `${title}: ${fresh.length} ${KadDates.plural(fresh.length, 'новый документ', 'новых документа', 'новых документов')}`,
    ...fresh.map((e) => `• ${KadDates.fmt(e.rec.date)} — ${e.cls.doc}`),
    `Стадия: ${s.stageLabel}`,
    s.hearing ? `Заседание: ${KadDates.fmt(s.hearing.date)}${s.hearing.time ? ' ' + s.hearing.time : ''}` : '',
    s.nextDue ? `Ближайший срок ${KadDates.fmt(s.nextDue.date)}: ${s.nextDue.what}` : '',
    st.url
  ].filter(Boolean);
  log(lines.join('\n  '));
  if (TELEGRAM && why === 'plan') await telegram(lines.join('\n'));
}

async function telegram(text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM.chat, text, disable_web_page_preview: true })
    });
    if (!r.ok) log(`Telegram ответил ${r.status}`);
  } catch (e) {
    log(`Telegram недоступен: ${e.message}`);
  }
}

/* ---------- плановая проверка ---------- */

let planBusy = false;
function planner() {
  if (!(CHECK_HOURS > 0)) { log('плановая проверка выключена (KAD_CHECK_HOURS=0)'); return; }
  const tick = async () => {
    let next = 10 * 60 * 1000;
    if (!planBusy) {
      planBusy = true;
      try {
        const stale = allIds().map((id) => { try { return load(id); } catch (_) { return null; } })
          .filter((st) => st && KAD_CARD.test(st.url || '') &&
            (!lastCheck(st) || Date.now() - Date.parse(lastCheck(st)) > CHECK_HOURS * 3600 * 1000))
          .sort((a, b) => String(lastCheck(a) || '').localeCompare(String(lastCheck(b) || '')));
        if (stale.length) {
          try { await refresh(stale[0].id, 'plan'); } catch (e) { log(`проверка ${stale[0].id}: ${e.message}`); }
          // Следующий спор — через минуту-другую, чтобы не частить в картотеку.
          if (stale.length > 1) next = 60 * 1000 + Math.random() * 60 * 1000;
        }
      } finally { planBusy = false; }
    }
    setTimeout(tick, next).unref();
  };
  setTimeout(tick, 20 * 1000).unref();
  log(`плановая проверка: каждые ${CHECK_HOURS} ч`);
}

/* ---------- HTTP ---------- */

function send(res, status, body, type) {
  const isJson = type === undefined;
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(data);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(new HttpError(400, 'тело запроса — не JSON')); }
    });
    req.on('error', reject);
  });
}

/*
 * Чужая страница в том же браузере может отправить запрос на 127.0.0.1.
 * Отсекаем: Host должен быть нашим (защита от подмены DNS), а изменяющие
 * запросы — идти с нашей же страницы и с JSON, который без разрешения
 * CORS другой сайт отправить не может.
 */
function guard(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (HOST === '127.0.0.1' && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'чужой адрес');
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'запрос с чужой страницы');
    if (!/application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'нужен JSON');
  }
}

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  guard(req);

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, assemble(), 'text/html; charset=utf-8');
  if (req.method === 'GET' && p === '/favicon.ico') return send(res, 204, '', 'image/x-icon');

  if (p === '/api/ping') return send(res, 200, { ok: true, checkHours: CHECK_HOURS, telegram: !!TELEGRAM, browser: fetcher.status() });

  if (p === '/api/fetch' && req.method === 'POST') {
    const { url } = await readBody(req);
    if (!KAD_CARD.test(String(url || ''))) throw new HttpError(400, 'нужна ссылка вида https://kad.arbitr.ru/Card/…');
    const got = await fetchCard(String(url));
    return send(res, 200, { text: got.text, at: got.at, source: 'kad.arbitr', note: got.note });
  }

  if (p === '/api/pdf' && req.method === 'GET') {
    const url = u.searchParams.get('url') || '';
    if (!KAD_PDF.test(url)) throw new HttpError(400, 'нужна ссылка на PDF картотеки');
    const text = await pdfTextCached(url);
    return send(res, 200, { text });
  }

  if (p === '/api/disputes' && req.method === 'GET') {
    const items = allIds().map((id) => {
      try {
        const st = load(id);
        return { id, filed: st.filed, url: st.url, checkedAt: lastCheck(st), error: st.error || null,
          savedAt: st.savedAt || null, summary: summaryOf(id, st) };
      } catch (e) {
        return { id, error: `файл повреждён: ${e.message}`, summary: {} };
      }
    });
    items.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    return send(res, 200, items);
  }

  if (p === '/api/disputes' && req.method === 'POST') {
    const st = clean(await readBody(req));
    st.id = crypto.randomBytes(6).toString('hex');
    st.createdAt = new Date().toISOString();
    st.savedAt = st.createdAt;
    // Документы, которые уже видны при постановке на отслеживание, новыми
    // не считаются — ни на странице, ни в уведомлениях.
    st.notified = [...(st.known || [])];
    store(st);
    log(`спор поставлен на отслеживание: ${st.id} (${st.url || 'без ссылки'})`);
    return send(res, 201, { id: st.id });
  }

  const m = p.match(/^\/api\/disputes\/([^/]+)(\/refresh)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2] && req.method === 'POST') return send(res, 200, await refresh(id, 'button'));
    if (m[2]) throw new HttpError(405, 'нужен POST');
    if (req.method === 'GET') return send(res, 200, load(id));
    if (req.method === 'PUT') {
      const prev = load(id);
      const st = clean(await readBody(req));
      for (const k of SERVER_FIELDS) if (prev[k] !== undefined) st[k] = prev[k];
      st.id = id;
      st.savedAt = new Date().toISOString();
      store(st);
      return send(res, 200, { id });
    }
    if (req.method === 'DELETE') {
      fs.rmSync(fileOf(id), { force: true });
      summaries.delete(id);
      log(`спор снят с отслеживания: ${id}`);
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'нет такого адреса');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) log(`ошибка ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) send(res, status, { error: e.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  log(`Обособленный спор: откройте http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  log(`данные: ${DATA}${HEADFUL ? ' · браузер с окном' : ''}${TELEGRAM ? ' · уведомления в Telegram' : ''}`);
  planner();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await fetcher.close();
    process.exit(0);
  });
}
