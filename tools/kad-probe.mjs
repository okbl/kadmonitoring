/*
 * Проба картотеки: пускает ли kad.arbitr.ru этот компьютер и как устроена
 * карточка. Печатает то, что нужно для настройки разбора: заголовок и начало
 * страницы, запросы страницы к API картотеки, поля записей API, результат
 * загрузчика и выделенный спор.
 *
 * Запуск: node tools/kad-probe.mjs <ссылка на карточку> [дата подачи дд.мм.гггг]
 */
import path from 'path';
import os from 'os';
import { KadFetcher } from '../server/kad-fetch.mjs';
import '../src/dates.js';
import '../src/kad.js';
import '../src/rules.js';
import '../src/dispute.js';

const { KadCard: C, KadDispute: X, KadDates: D } = globalThis;
const url = process.argv[2];
const filed = process.argv[3] ? D.parse(process.argv[3]) : null;
const headful = /^(1|true)$/i.test(process.env.KAD_WINDOW || '');
if (!url) { console.error('нужна ссылка на карточку'); process.exit(2); }

const section = (t) => console.log(`\n===== ${t} =====`);
const fetcher = new KadFetcher({
  profileDir: path.join(os.tmpdir(), 'kad-probe-profile'),
  headful,
  browserPath: process.env.KAD_BROWSER || ''
});

let failed = false;
try {
  /* 1. Страница как есть: что отвечает картотека и что запрашивает сама страница. */
  section(`сырой заход${headful ? ' (с окном)' : ''}`);
  const ctx = await fetcher.context();
  const page = await ctx.newPage();
  const calls = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (!/arbitr\.ru/i.test(u) || /\.(?:css|png|jpe?g|gif|svg|woff2?|ico)(?:\?|$)/i.test(u)) return;
    const ct = res.headers()['content-type'] || '';
    const rec = { status: res.status(), type: ct.split(';')[0], url: u.slice(0, 200) };
    if (/json/i.test(ct)) {
      try { rec.json = await res.json(); } catch (_) { /* тело недоступно */ }
    }
    calls.push(rec);
  });
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => { console.log('goto:', e.message); return null; });
  console.log('HTTP', resp && resp.status(), '·', await page.title().catch(() => ''));
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const body = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  console.log(`текст страницы: ${body.length} симв.`);
  console.log(body.slice(0, 2500));

  section('запросы страницы к arbitr.ru');
  for (const c of calls) console.log(c.status, c.type, c.url);

  section('записи API');
  for (const c of calls.filter((x) => x.json)) {
    const j = c.json;
    const items = j && j.Result && Array.isArray(j.Result.Items) ? j.Result.Items : null;
    console.log(c.url);
    console.log('  ключи ответа:', Object.keys(j || {}).join(', '), j && j.Result ? '· Result: ' + Object.keys(j.Result).join(', ') : '');
    if (items && items.length) {
      console.log(`  записей: ${items.length}; поля записи: ${Object.keys(items[0]).join(', ')}`);
      for (const it of items.slice(0, 3)) console.log('  ', JSON.stringify(it).slice(0, 1500));
    }
  }

  section('HTML записи хронологии (образец)');
  const sample = await page.evaluate(() => {
    const el = document.querySelector('[class*="chrono-item"], [class*="chrono"] li, .b-chrono-item');
    return el ? el.outerHTML.slice(0, 3000) : 'не найдено';
  }).catch(() => '');
  console.log(sample);
  await page.close();

  /* 2. Загрузчик программы — то, что получит сервер. */
  section('загрузчик программы');
  const r = await fetcher.card(url);
  console.log(`текст страницы: ${r.pageText.length} симв. · записей из API: ${r.apiItems}`);
  for (const [name, text] of [['страница', r.pageText], ['API', r.apiText]]) {
    if (!text) continue;
    const card = C.parse(text);
    console.log(`\n-- разбор (${name}): записей ${card.records.length}, с «В ответ на» ${card.diagnostics.withResponseTo}, с PDF ${card.diagnostics.withPdf}; дело ${card.meta.caseNo || '?'}`);
    for (const rec of card.records.slice(-12)) {
      console.log(`  ${D.fmt(rec.date)} | ${C.title(rec).slice(0, 90)} | ${String(rec.from || '').slice(0, 40)} | ${String(rec.responseTo || '').slice(0, 90)}`);
    }
    if (filed) {
      const d = X.build(card, { filedDate: filed });
      const s = X.summary(d);
      console.log(`  СПОР: заявление ${d.root ? D.fmt(d.root.date) + ' ' + C.title(d.root).slice(0, 60) : 'не найдено'}; событий ${d.events.length}; стадия «${s.stageLabel}»; роль ${d.role}`);
      for (const e of d.events) console.log(`    ${D.fmt(e.rec.date)} ${e.cls.doc} [${e.confidence}]`);
    }
  }
  if (!r.pageText && !r.apiItems) failed = true;
} catch (e) {
  failed = true;
  console.log('ОШИБКА:', e.message);
} finally {
  await fetcher.close();
}
process.exit(failed ? 1 : 0);
