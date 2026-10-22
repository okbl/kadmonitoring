/*
 * Обработчик для сайта программы: загружает карточки kad.arbitr и тексты
 * определений вместо браузера пользователя. Сайт присылает ссылку — здесь
 * её открывает настоящий браузер (Chromium, server/kad-fetch.mjs), забирает
 * хронологию со всех страниц и инстанций и отдаёт сайту; ссылку на PDF —
 * отдаёт текст определения.
 *
 * Ничего не хранит, кроме кэша текстов определений (они не меняются) и
 * профиля браузера: список споров и их данные остаются в браузерах
 * пользователей. Отвечает только сайту программы (CORS) и только по ключу.
 *
 *   POST /card  {"url": "https://kad.arbitr.ru/Card/…"} → { text, note, at, source }
 *   POST /pdf   {"url": "https://kad.arbitr.ru/Kad/PdfDocument/…"} → { text }
 *   GET  /ping  → { ok, browser }
 *
 * Заголовок X-Kad-Key — ключ доступа (KAD_KEY). Без ключа обработчик любой
 * мог бы использовать, чтобы нагружать картотеку от вашего имени.
 *
 * Переменные окружения:
 *   PORT (8787), HOST (0.0.0.0), KAD_KEY — ключ доступа (обязателен, если
 *   обработчик доступен из интернета), KAD_ORIGINS — адреса сайтов через
 *   запятую (https://okbl.github.io), KAD_PROFILE — папка профиля браузера,
 *   KAD_CACHE — папка кэша текстов, KAD_BROWSER — путь к Chrome/Chromium.
 *
 * Запуск: node handler.mjs (или Docker-образ — см. Dockerfile и README).
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { KadFetcher } from './server/kad-fetch.mjs';
import { pdfText } from './server/pdf-text.mjs';
import './src/kad-items.js';
import './src/dates.js';
import './src/kad.js';

const env = process.env;
const PORT = +(env.PORT || 8787);
const HOST = env.HOST || '0.0.0.0';
const KEY = env.KAD_KEY || '';
const ORIGINS = (env.KAD_ORIGINS || 'https://okbl.github.io').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const CACHE = path.resolve(env.KAD_CACHE || path.join(os.tmpdir(), 'kad-handler-cache'));
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KAD_CARD = new RegExp(`^https?://(?:www\\.)?kad\\.arbitr\\.ru/Card/${GUID}`, 'i');
const KAD_PDF = /^https?:\/\/(?:www\.)?kad\.arbitr\.ru\/(?:Document\/Pdf|Kad\/PdfDocument)\//i;
const MAX_BODY = 16 * 1024;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const fetcher = new KadFetcher({
  profileDir: path.resolve(env.KAD_PROFILE || path.join(os.tmpdir(), 'kad-handler-profile')),
  browserPath: env.KAD_BROWSER || '',
  base: env.KAD_BASE || 'https://kad.arbitr.ru',
  log
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* CORS: ответы читает только сайт программы. */
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kad-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    // Обработчик во внутренней сети организации, сайт — в интернете: Chrome
    // спрашивает об этом отдельно (Private Network Access).
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function checkKey(req) {
  if (!KEY) return;
  const got = Buffer.from(String(req.headers['x-kad-key'] || ''));
  const want = Buffer.from(KEY);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, 'неверный ключ обработчика');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'слишком большой запрос')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(new HttpError(400, 'тело запроса — не JSON')); }
    });
    req.on('error', reject);
  });
}

async function card(url) {
  let r;
  try { r = await fetcher.card(url); } catch (e) { throw new HttpError(e.status || 502, e.message); }
  try {
    return globalThis.KadItems.cardFrom(r, url.match(KAD_CARD)[0]);
  } catch (e) { throw new HttpError(e.status || 502, e.message); }
}

/* Тексты судебных актов не меняются — кэш бережёт картотеку. */
async function pdf(url) {
  const key = crypto.createHash('sha1').update(url.replace(/[?#].*$/, '')).digest('hex');
  const f = path.join(CACHE, `${key}.txt`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  let buf;
  try { buf = await fetcher.pdf(url); } catch (e) { throw new HttpError(502, e.message); }
  const text = await pdfText(buf);
  if (!text.trim()) throw new HttpError(422, 'в PDF нет текстового слоя — это скан');
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, text);
  return text;
}

async function route(req, res) {
  cors(req, res);
  const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && (p === '/' || p === '/ping')) return send(res, 200, { ok: true, app: 'kadmonitoring-handler', key: !!KEY, browser: fetcher.status() });
  if (req.method !== 'POST') throw new HttpError(404, 'нет такого адреса');
  checkKey(req);
  const { url } = await readBody(req);
  const u = String(url || '');
  const t0 = Date.now();
  if (p === '/card') {
    if (!KAD_CARD.test(u)) throw new HttpError(400, 'нужна ссылка вида https://kad.arbitr.ru/Card/…');
    const got = await card(u);
    log(`карточка: ${Date.now() - t0} мс · ${got.note}`);
    return send(res, 200, got);
  }
  if (p === '/pdf') {
    if (!KAD_PDF.test(u)) throw new HttpError(400, 'нужна ссылка на PDF картотеки');
    const text = await pdf(u);
    log(`текст определения: ${Date.now() - t0} мс`);
    return send(res, 200, { text });
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
server.requestTimeout = 300000;

server.listen(PORT, HOST, () => {
  log(`обработчик kad.arbitr: http://${HOST}:${PORT} · сайты: ${ORIGINS.join(', ')} · ключ ${KEY ? 'задан' : 'НЕ ЗАДАН — задайте KAD_KEY, если обработчик доступен из интернета'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await fetcher.close();
    process.exit(0);
  });
}
