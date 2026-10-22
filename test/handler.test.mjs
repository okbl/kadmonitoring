/*
 * Свой обработчик (handler.mjs) против макета картотеки и сайт, который
 * загружает карточки через него — без вкладки kad.arbitr и закладки:
 * подключение ссылкой #handler=…&key=…, ссылка и дата — и спор загружен,
 * текст определения — через проверку картотеки перед PDF; обработчик
 * отвечает только сайту программы (CORS) и только по ключу.
 *
 * Нужен Chromium: KAD_CHROMIUM либо /opt/pw-browsers/chromium. Без него тест пропускается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { startMock, CASE } from './mock-kad.mjs';
import { assemble } from '../build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD = `https://kad.arbitr.ru/Card/${CASE}`;
const KEY = 'test-key-123';

function chromiumPath() {
  for (const p of [process.env.KAD_CHROMIUM, '/opt/pw-browsers/chromium']) if (p && fs.existsSync(p)) return p;
  return null;
}

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

async function startHandler(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['handler.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/обработчик kad\.arbitr:/.test(out); i++) await new Promise((ok) => setTimeout(ok, 100));
  return { url: `http://127.0.0.1:${port}`, child, log: () => out };
}

test('свой обработчик: сайт загружает карточку и PDF без вкладки kad, CORS и ключ', async (t) => {
  const exe = chromiumPath();
  let pw;
  try { pw = await import('playwright-core'); } catch (_) { pw = null; }
  if (!exe || !pw) { t.skip('нет Chromium'); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kad-handler-'));
  const mock = await startMock({ cardCheck: true, site: assemble() });
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext();
  const pp = await ctx.newPage();
  await pp.setContent(`<html><body><p>О П Р Е Д Е Л И Л:</p>
    <p>Отложить судебное заседание на 21.10.2026 на 14 час. 20 мин.</p></body></html>`);
  mock.setPdf(await pp.pdf({ format: 'A4' }));
  await pp.close();

  const h = await startHandler({
    KAD_KEY: KEY, KAD_ORIGINS: mock.siteBase, KAD_BASE: mock.base, KAD_BROWSER: exe,
    KAD_PROFILE: path.join(tmp, 'profile'), KAD_CACHE: path.join(tmp, 'cache')
  });
  t.after(async () => {
    h.child.kill('SIGTERM');
    await browser.close();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  assert.match(h.log(), /обработчик kad\.arbitr:/, 'обработчик запустился');

  // Отвечает только сайту программы и только по ключу.
  const pre = await fetch(`${h.url}/card`, { method: 'OPTIONS', headers: { Origin: mock.siteBase, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), mock.siteBase);
  const alien = await fetch(`${h.url}/card`, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } });
  assert.equal(alien.headers.get('access-control-allow-origin'), null, 'чужому сайту CORS не разрешён');
  const nokey = await fetch(`${h.url}/card`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: CARD }) });
  assert.equal(nokey.status, 401, 'без ключа — отказ');

  await ctx.addInitScript((o) => { if (location.pathname.startsWith('/site/')) window.KAD_TEST_ORIGIN = o; }, mock.base);
  const errors = [];
  const site = await ctx.newPage();
  site.on('pageerror', (e) => errors.push(e.message));

  // Подключение ссылкой от администратора.
  await site.goto(`${mock.siteBase}/site/#handler=${encodeURIComponent(h.url)}&key=${KEY}`);
  await site.waitForSelector('body.local.handler');
  await site.waitForFunction(() => /работает/.test(document.getElementById('handlerState').textContent));
  assert.match(await site.textContent('#kadState'), /через обработчик/);
  assert.equal(new URL(site.url()).hash, '', 'ключ убран из адреса');

  // Ссылка и дата — и всё. Вкладок kad не открывается.
  const pages = ctx.pages().length;
  await site.click('#btnNew');
  assert.equal(await site.isVisible('#install'), false, 'с обработчиком блок про закладку не нужен');
  await site.fill('#dateInput', '23.06.2026');
  await site.dispatchEvent('#dateInput', 'change');
  await site.fill('#urlInput', CARD);
  await site.waitForFunction(() => /к спору относятся/.test(document.getElementById('pasteEcho').textContent), null, { timeout: 120000 });
  assert.equal(await site.$$eval('#timeline details.ev', (els) => els.length), 6);
  assert.equal(ctx.pages().length, pages, 'вкладка kad не открывалась');
  await site.waitForFunction(() => /^#d=/.test(location.hash));

  // Текст определения — тоже через обработчик.
  let texts = 0;
  for (let i = 0; i < 120 && !texts; i++) {
    texts = await site.evaluate(() => new Promise((ok) => {
      const q = indexedDB.open('kadmonitoring', 1);
      q.onsuccess = () => {
        const tx = q.result.transaction('kv');
        const g = tx.objectStore('kv').get('ids');
        g.onsuccess = () => {
          const ids = g.result || [];
          if (!ids.length) return ok(0);
          const d = tx.objectStore('kv').get(`d:${ids[0]}`);
          d.onsuccess = () => ok(Object.values((d.result && d.result.texts) || {}).filter((x) => /О П Р Е Д Е Л И Л/.test(x)).length);
        };
      };
    }));
    if (!texts) await site.waitForTimeout(500);
  }
  assert.ok(texts > 0, 'текст определения загружен обработчиком');
  assert.deepEqual(errors, []);
});
