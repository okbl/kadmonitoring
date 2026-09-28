/*
 * Сквозная проверка сервера на макете картотеки (test/mock-kad.mjs):
 * загрузка карточки по ссылке, PDF определения, постановка спора на
 * отслеживание и проверка обновлений. Нужен браузер: путь в KAD_BROWSER
 * либо Chromium из playwright. Без браузера тест пропускается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { startMock, CASE, ITEMS } from './mock-kad.mjs';
import { C, X } from './load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_CARD = `https://kad.arbitr.ru/Card/${CASE}`;

async function browser() {
  let pw;
  try { pw = await import('playwright-core'); } catch (_) { return null; }
  const candidates = [process.env.KAD_BROWSER, '/opt/pw-browsers/chromium', ''].filter((x) => x !== undefined);
  for (const exe of candidates) {
    try {
      const b = await pw.chromium.launch(exe ? { executablePath: exe } : {});
      return { b, exe };
    } catch (_) { /* следующий */ }
  }
  return null;
}

/* PDF определения печатает тот же браузер — с настоящим текстовым слоем. */
async function rulingPdf(b) {
  const p = await b.newPage();
  await p.setContent(`<html><body>
    <p>АРБИТРАЖНЫЙ СУД ГОРОДА МОСКВЫ</p><p>О П Р Е Д Е Л Е Н И Е</p>
    <p>Руководствуясь статьями 158, 184 АПК РФ, суд</p><p>О П Р Е Д Е Л И Л:</p>
    <p>Отложить судебное заседание на 21.10.2026 на 14 час. 20 мин.</p>
    <p>Финансовому управляющему представить в суд выписки по счетам должника в срок до 14.10.2026.</p>
  </body></html>`);
  const pdf = await p.pdf({ format: 'A4' });
  await p.close();
  return pdf;
}

async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), KAD_CHECK_HOURS: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 50 && !/откройте/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, opts = {}) => {
    const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { base, api, log: () => out, stop: () => child.kill('SIGINT') };
}

test('сервер: карточка по ссылке, PDF, отслеживание', async (t) => {
  const br = await browser();
  if (!br) { t.skip('нет браузера для playwright-core'); return; }
  const pdf = await rulingPdf(br.b);
  await br.b.close();

  const mock = await startMock({ pdf });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kad-data-'));
  const srv = await startServer({
    KAD_BASE: mock.base, KAD_DATA: data, KAD_PROFILE: path.join(data, 'profile'), KAD_BROWSER: br.exe
  });
  t.after(async () => { srv.stop(); await mock.close(); fs.rmSync(data, { recursive: true, force: true }); });

  const ping = await srv.api('/api/ping');
  assert.equal(ping.body.ok, true);

  // Чужой адрес карточки и запрос с чужой страницы отклоняются.
  assert.equal((await srv.api('/api/fetch', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/Card/x' }) })).status, 400);
  assert.equal((await srv.api('/api/fetch', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);

  // Карточка: на странице только первая страница хронологии, остальное — из API.
  const got = await srv.api('/api/fetch', { method: 'POST', body: JSON.stringify({ url: URL_CARD }) });
  assert.equal(got.status, 200, JSON.stringify(got.body) + srv.log());
  assert.match(got.body.note, new RegExp(`${ITEMS.length} документов из хронологии`));
  const card = C.parse(got.body.text);
  assert.equal(card.meta.caseNo, 'А40-123456/2025');
  const d = X.build(card, { filedDate: '2026-06-23' });
  assert.deepEqual(d.events.map((e) => e.rec.date),
    ['2026-06-23', '2026-06-26', '2026-07-10', '2026-07-15', '2026-08-05', '2026-09-16']);
  assert.ok(d.events.slice(1).every((e) => e.reasons.includes('ссылка на документ картотеки')));
  assert.deepEqual([d.hearing.date, d.hearing.time], ['2026-10-21', '14:20']);
  const act = d.events.find((e) => e.rec.date === '2026-09-16');
  assert.match(act.rec.pdf, /^https:\/\/kad\.arbitr\.ru\/Kad\/PdfDocument\//);

  // Текст определения из PDF.
  const pdfRes = await srv.api(`/api/pdf?url=${encodeURIComponent(act.rec.pdf)}`);
  assert.equal(pdfRes.status, 200, JSON.stringify(pdfRes.body));
  assert.match(pdfRes.body.text, /О П Р Е Д Е Л И Л:/);

  // Отслеживание: документы, видимые при постановке, новыми не считаются.
  const state = {
    app: 'kadmonitoring', v: 1, filed: '2026-06-23', url: URL_CARD,
    card: { raw: got.body.text, html: false, source: 'kad.arbitr', at: got.body.at },
    texts: {}, include: [], exclude: [], known: d.events.slice(0, 4).map((e) => e.rec.id)
  };
  const created = await srv.api('/api/disputes', { method: 'POST', body: JSON.stringify(state) });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const refreshed = await srv.api(`/api/disputes/${id}/refresh`, { method: 'POST' });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body) + srv.log());
  assert.equal(refreshed.body.summary.newEvents, 2);
  assert.equal(refreshed.body.summary.stageLabel, 'Рассматривается');

  const saved = (await srv.api(`/api/disputes/${id}`)).body;
  assert.ok(saved.checkedAt);
  assert.ok(Object.values(saved.texts).some((x) => /ОПРЕДЕЛИЛ|О П Р Е Д Е Л И Л/.test(x)), 'тексты актов спора загружены при проверке');

  const list = (await srv.api('/api/disputes')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].summary.caseNo, 'А40-123456/2025');
  // Поручение из текста определения стало ближайшим сроком.
  assert.equal(list[0].summary.nextDue.date, '2026-10-14');

  assert.equal((await srv.api(`/api/disputes/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await srv.api('/api/disputes/../../etc')).status, 404);
});

test('сервер: проверка «вы не робот» — понятная ошибка, а не пустой спор', async (t) => {
  const br = await browser();
  if (!br) { t.skip('нет браузера для playwright-core'); return; }
  await br.b.close();
  const mock = await startMock({ wall: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kad-data-'));
  const srv = await startServer({ KAD_BASE: mock.base, KAD_DATA: data, KAD_PROFILE: path.join(data, 'profile'), KAD_BROWSER: br.exe });
  t.after(async () => { srv.stop(); await mock.close(); fs.rmSync(data, { recursive: true, force: true }); });
  const got = await srv.api('/api/fetch', { method: 'POST', body: JSON.stringify({ url: URL_CARD }) });
  assert.equal(got.status, 502);
  assert.match(got.body.error, /не робот.*start:window/);
});
