/*
 * Сайт без расширения: Chromium без расширений, страница программы с одного
 * адреса (localhost), «картотека» — макет с другого (127.0.0.1). Карточки
 * загружает вкладка картотеки, в которой «нажата» закладка «Спор ← kad»;
 * проверяется то, что увидит пользователь: ссылка и дата — и спор загружен
 * со всех страниц хронологии, текст определения — через проверку картотеки
 * перед PDF, спор в «Моих спорах» (IndexedDB сайта), новый документ при
 * проверке, связь восстанавливается после перезагрузки сайта.
 *
 * Нужен Chromium: KAD_CHROMIUM либо /opt/pw-browsers/chromium. Без него тест пропускается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { startMock, CASE, ITEMS } from './mock-kad.mjs';
import { assemble } from '../build.mjs';

const CARD = `https://kad.arbitr.ru/Card/${CASE}`;

function chromiumPath() {
  for (const p of [process.env.KAD_CHROMIUM, '/opt/pw-browsers/chromium']) if (p && fs.existsSync(p)) return p;
  return null;
}

/* Споры сайта — прямо из его IndexedDB. */
const stored = () => new Promise((resolve) => {
  const q = indexedDB.open('kadmonitoring', 1);
  q.onsuccess = () => {
    const db = q.result;
    const get = (k) => new Promise((ok) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); });
    get('ids').then(async (ids) => resolve({ ids: ids || [], first: ids && ids.length ? await get(`d:${ids[0]}`) : null }));
  };
});

test('сайт без расширения: закладка во вкладке kad — ссылка и дата, PDF, отслеживание, переподключение', async (t) => {
  const exe = chromiumPath();
  let pw;
  try { pw = await import('playwright-core'); } catch (_) { pw = null; }
  if (!exe || !pw) { t.skip('нет Chromium'); return; }

  const mock = await startMock({ apiReferer: true, site: assemble() });
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext();
  const added = ITEMS.length;
  t.after(async () => { ITEMS.splice(added); await browser.close(); await mock.close(); });

  // Определение в PDF — с настоящим текстовым слоем.
  const pp = await ctx.newPage();
  await pp.setContent(`<html><body><p>О П Р Е Д Е Л И Л:</p>
    <p>Отложить судебное заседание на 21.10.2026 на 14 час. 20 мин.</p>
    <p>Финансовому управляющему представить в суд выписки по счетам должника в срок до 14.10.2026.</p></body></html>`);
  mock.setPdf(await pp.pdf({ format: 'A4' }));
  await pp.close();

  // Картотека в тесте — макет: сайту сообщается её адрес (на настоящем сайте это kad.arbitr.ru).
  await ctx.addInitScript((o) => { if (location.pathname.startsWith('/site/')) window.KAD_TEST_ORIGIN = o; }, mock.base);

  const errors = [];
  const site = await ctx.newPage();
  site.on('pageerror', (e) => errors.push(e.message));
  await site.goto(`${mock.siteBase}/site/`);
  await site.waitForSelector('body.local');
  assert.ok(await site.isVisible('#listSec'), 'сайт открывается списком споров');
  assert.match(await site.textContent('#kadState'), /нет связи/);

  const href = await site.getAttribute('#bookmarklet', 'href');
  assert.match(href, /^javascript:/, 'кнопка закладки — адрес javascript:');
  const bookmark = decodeURIComponent(href.slice('javascript:'.length));

  // Новый спор: дата и ссылка. Связи нет — сайт сам открывает вкладку карточки.
  await site.click('#btnNew');
  assert.ok(await site.isVisible('#install'), 'без связи виден блок про закладку');
  await site.fill('#dateInput', '23.06.2026');
  await site.dispatchEvent('#dateInput', 'change');
  const [kad] = await Promise.all([ctx.waitForEvent('page'), site.fill('#urlInput', CARD)]);
  kad.on('pageerror', (e) => errors.push(`kad: ${e.message}`));
  await kad.waitForSelector('#chrono li');
  assert.match(await site.textContent('#pasteEcho'), /нажмите в ней закладку/);

  // Во вкладке картотеки «нажимают» закладку — загрузка продолжается сама.
  await kad.evaluate(bookmark);
  await site.waitForFunction(() => /к спору относятся/.test(document.getElementById('pasteEcho').textContent), null, { timeout: 60000 });
  assert.equal(await site.$$eval('#timeline details.ev', (els) => els.length), 6, 'заявление и пять документов — со всех страниц хронологии');
  assert.match(await site.textContent('#kadState'), /связь есть/);
  assert.equal(await site.isVisible('#install'), false, 'со связью блок про закладку скрыт');
  assert.match(await kad.textContent('body'), /Вкладка связана с сайтом/);

  // Спор встал на отслеживание сам; текст определения — из PDF за проверкой картотеки.
  await site.waitForFunction(() => /^#d=/.test(location.hash));
  await site.waitForFunction(async (fn) => {
    const s = await (0, eval)(fn)();
    return s.first && Object.values(s.first.texts || {}).some((x) => /О П Р Е Д Е Л И Л/.test(x));
  }, stored.toString(), { timeout: 60000 });
  assert.ok(mock.hits.some((h) => h.startsWith('/Document/Pdf/')), 'PDF взят за проверкой картотеки');
  const s1 = await site.evaluate(async (fn) => (0, eval)(fn)(), stored.toString());
  assert.equal(s1.ids.length, 1);
  assert.equal(s1.first.summary.caseNo, 'А40-123456/2025');

  // Новый документ в карточке и проверка по кнопке.
  await site.click('#btnList');
  await site.waitForSelector('.drow');
  ITEMS.push({ ...ITEMS[ITEMS.length - 1], Id: '00000000-0000-4000-8000-000000000099', DisplayDate: '25.09.2026',
    ContentTypes: ['Об отложении судебного разбирательства'], HearingDate: null });
  await site.click('[data-check]');
  await site.waitForFunction(() => /новое: 1/.test(document.getElementById('list').textContent), null, { timeout: 60000 });
  assert.match(await site.title(), /^\(1\) /, 'споры с новым — в заголовке вкладки');

  // Сайт перезагрузили — связь с вкладкой картотеки восстанавливается сама.
  await site.reload();
  await site.waitForSelector('body.local');
  await site.waitForFunction(() => /связь есть/.test(document.getElementById('kadState').textContent), null, { timeout: 10000 });

  // Вкладку картотеки закрыли — сайт это видит.
  await kad.close();
  await site.waitForFunction(() => /нет связи/.test(document.getElementById('kadState').textContent), null, { timeout: 10000 });
  assert.deepEqual(errors, []);
});

test('файл с диска: загрузка по ссылке — на сайте, вставка вручную работает', async (t) => {
  let pw;
  try { pw = await import('playwright-core'); } catch (_) { pw = null; }
  const exe = chromiumPath();
  if (!exe || !pw) { t.skip('нет Chromium'); return; }
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(assemble(), { waitUntil: 'load' });
  await page.waitForFunction(() => document.body && !document.body.classList.contains('server') && typeof document.body.className === 'string');
  assert.equal(await page.isVisible('#paste'), false, 'поле вставки свёрнуто');
  await page.click('#manual summary');
  assert.equal(await page.isVisible('#paste'), true);
});
