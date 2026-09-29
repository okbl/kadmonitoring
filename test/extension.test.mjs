/*
 * Расширение браузера целиком: Chromium с загруженным расширением против
 * макета картотеки (test/mock-kad.mjs). Проверяется то, что увидит
 * пользователь: ссылка и дата — и карточка загружена (все страницы
 * хронологии), спор в «Моих спорах», текст определения из PDF за проверкой
 * картотеки, новый документ при проверке, та же страница на сайте через
 * расширение — и что всё лежит в хранилище этого браузера.
 *
 * Нужен Chromium, который умеет расширения в режиме без окна: путь в
 * KAD_CHROMIUM либо /opt/pw-browsers/chromium. Без него тест пропускается.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startMock, CASE, ITEMS } from './mock-kad.mjs';
import { assemble, extensionFiles, extensionId, writeDir } from '../build.mjs';

const CARD = `https://kad.arbitr.ru/Card/${CASE}`;

function chromiumPath() {
  for (const p of [process.env.KAD_CHROMIUM, '/opt/pw-browsers/chromium']) if (p && fs.existsSync(p)) return p;
  return null;
}

async function rulingPdf(ctx) {
  const p = await ctx.newPage();
  await p.setContent(`<html><body><p>О П Р Е Д Е Л И Л:</p>
    <p>Отложить судебное заседание на 21.10.2026 на 14 час. 20 мин.</p>
    <p>Финансовому управляющему представить в суд выписки по счетам должника в срок до 14.10.2026.</p></body></html>`);
  const pdf = await p.pdf({ format: 'A4' });
  await p.close();
  return pdf;
}

test('расширение: только ссылка и дата — карточка, отслеживание, PDF, новый документ, сайт', async (t) => {
  const exe = chromiumPath();
  let pw;
  try { pw = await import('playwright-core'); } catch (_) { pw = null; }
  if (!exe || !pw) { t.skip('нет Chromium для расширений'); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kad-ext-'));
  // Карточку макет отдаёт только браузеру, прошедшему проверку, а API —
  // только запросам с Referer карточки.
  const mock = await startMock({ cardCheck: true, apiReferer: true, site: assemble() });
  const dir = path.join(tmp, 'ext');
  writeDir(dir, extensionFiles({ base: mock.base, site: mock.base }));
  const ctx = await pw.chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    executablePath: exe,
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
  });
  const added = ITEMS.length;
  t.after(async () => {
    ITEMS.splice(added);
    await ctx.close();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // PDF определения печатает тот же браузер — с настоящим текстовым слоем.
  mock.setPdf(await rulingPdf(ctx));

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  assert.equal(extId, extensionId(), 'идентификатор расширения — из ключа в manifest.json');
  const steps = () => sw.evaluate(() => globalThis.kadTrace.map((x) => x.step));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extId}/app.html`);
  await page.waitForSelector('body.ext');
  assert.ok(await page.isVisible('#listSec'), 'страница расширения открывается списком споров');

  // Новый спор: дата и ссылка — больше ничего не нажимается.
  await page.click('#btnNew');
  assert.equal(await page.isVisible('#paste'), false, 'поле ручной вставки свёрнуто');
  assert.equal(await page.isVisible('#install'), false, 'с расширением блок установки не показывается');
  await page.fill('#dateInput', '23.06.2026');
  await page.dispatchEvent('#dateInput', 'change');
  await page.fill('#urlInput', CARD);
  await page.waitForFunction(() => /к спору относятся/.test(document.getElementById('pasteEcho').textContent), null, { timeout: 90000 });
  const events = await page.$$eval('#timeline details.ev', (els) => els.length);
  assert.equal(events, 6, 'заявление и пять документов спора — с обеих страниц хронологии');
  assert.match(await page.textContent('#tiles'), /Рассматривается/);
  // Без cookie картотека отдала проверку — карточку открыла вкладка.
  assert.deepEqual(await steps(), ['direct', 'tab', 'tab-api']);

  // Спор встал на отслеживание сам — данные в хранилище браузера.
  await page.waitForFunction(() => /^#d=/.test(location.hash));
  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  assert.equal(stored.ids.length, 1);
  const st = stored[`d:${stored.ids[0]}`];
  assert.equal(st.url, CARD);
  assert.equal(st.summary.caseNo, 'А40-123456/2025');

  // Тексты определений загружаются по умолчанию.
  await page.click('#btnList');
  await page.waitForSelector('.drow');
  assert.equal(await page.isChecked('#setPdf'), true);

  // Новый документ в карточке и проверка по кнопке. Проверку картотеки
  // вкладка уже прошла — теперь карточка берётся без вкладки: API — с
  // заголовками страницы карточки.
  ITEMS.push({ ...ITEMS[ITEMS.length - 1], Id: '00000000-0000-4000-8000-000000000099', DisplayDate: '25.09.2026',
    ContentTypes: ['Об отложении судебного разбирательства'], HearingDate: null });
  await page.click('[data-check]');
  await page.waitForFunction(() => /новое: 1/.test(document.getElementById('list').textContent), null, { timeout: 180000 });
  assert.deepEqual(await steps(), ['direct', 'direct-api', 'direct-api-referer']);

  const after = await sw.evaluate(() => chrome.storage.local.get(null));
  const st2 = after[`d:${after.ids[0]}`];
  assert.ok(Object.values(st2.texts || {}).some((x) => /О П Р Е Д Е Л И Л/.test(x)), 'тексты определений загружены через проверку картотеки');
  assert.ok(st2.checkedAt);
  // Прямой запрос файла макет, как и kad, не обслуживает — текст взят переходом во вкладке.
  assert.ok(mock.hits.some((h) => /^\/(?:Document\/Pdf|Kad\/PdfDocument)\//.test(h)), 'PDF взят у картотеки');

  // Открыть спор: новый документ помечен, затем отмечен как просмотренный.
  await page.click('.drow');
  await page.waitForSelector('#timeline .b.new');
  assert.match(await page.textContent('#timeline'), /25\.09\.2026/);
  assert.deepEqual(errors, []);

  // Та же страница на сайте программы работает через расширение: тот же
  // список, ссылка и дата — и спор загружен и отслеживается.
  const site = await ctx.newPage();
  site.on('pageerror', (e) => errors.push(e.message));
  await site.goto(`${mock.base}/site/`);
  await site.waitForSelector('body.ext');
  await site.waitForSelector('.drow');
  assert.equal(await site.isVisible('#install'), false);
  await site.click('#btnNew');
  await site.fill('#urlInput', CARD);
  await site.fill('#dateInput', '20.06.2026');
  await site.dispatchEvent('#dateInput', 'change');
  await site.waitForFunction(() => /к спору относятся/.test(document.getElementById('pasteEcho').textContent), null, { timeout: 90000 });
  await site.waitForFunction(() => /^#d=/.test(location.hash));
  const all = await sw.evaluate(() => chrome.storage.local.get(null));
  assert.equal(all.ids.length, 2, 'второй спор — из страницы на сайте, в том же хранилище');
  assert.deepEqual(errors, []);
});

test('сайт без расширения: кнопка загрузки ведёт к установке, вставка — запасной путь', async (t) => {
  let pw;
  try { pw = await import('playwright-core'); } catch (_) { pw = null; }
  const exe = chromiumPath();
  if (!exe || !pw) { t.skip('нет Chromium'); return; }
  const mock = await startMock({ site: assemble() });
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  t.after(async () => { await browser.close(); await mock.close(); });
  const page = await browser.newPage();
  await page.goto(`${mock.base}/site/`);
  await page.waitForSelector('#install', { state: 'visible' });
  assert.equal(await page.isVisible('#paste'), false, 'поле вставки свёрнуто');
  await page.fill('#urlInput', CARD);
  await page.click('#btnFetch');
  await page.waitForSelector('#install.flash');
  await page.click('#manual summary');
  assert.equal(await page.isVisible('#paste'), true);
});
