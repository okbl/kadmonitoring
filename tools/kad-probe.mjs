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
  console.log('запросы API:');
  for (const u of r.apiUrls || []) console.log('  ', u.slice(0, 220));
  const raw = r.apiRaw || [];
  if (raw.length) {
    console.log(`поля записи: ${Object.keys(raw[0]).join(', ')}`);
    for (const it of raw.slice(0, 3)) console.log('  образец:', JSON.stringify(it).slice(0, 2500));
    console.log('все записи (дата | тип | содержание | подал | в ответ на):');
    const s = (v) => typeof v === 'string' ? v : JSON.stringify(v);
    for (const it of raw) {
      const reason = Object.entries(it).filter(([k]) => /reason|answer|response|parent/i.test(k)).map(([k, v]) => `${k}=${s(v)}`).join(' ');
      console.log('  ', [it.DisplayDate || it.Date, it.DocumentTypeName, s(it.ContentTypes || it.Content || ''), s(it.Declarers || ''), reason]
        .map((x) => String(x == null ? '' : x).replace(/\s+/g, ' ').slice(0, 160)).join(' | '));
    }
  }
  console.log('\nтекст страницы целиком (первые 7000 симв.):');
  console.log(r.pageText.slice(0, 7000));
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

  /* 3. PDF последнего судебного акта спора — проверка загрузки и разбора текста. */
  const R = globalThis.KadRules;
  const texts = [r.apiText, r.pageText].filter(Boolean).map((t) => C.parse(t));
  const acts = texts.flatMap((c) => c.records).filter((x) => x.pdf && /23\.06\.2026/.test(x.responseTo || ''));
  const act = acts.sort((a, b) => a.date < b.date ? 1 : -1)[0];
  section('PDF акта по заявлению от 23.06.2026');
  if (!act) console.log('актов со ссылкой на PDF в ответ на заявление от 23.06.2026 не найдено');
  else {
    console.log(D.fmt(act.date), C.title(act), act.pdf);
    try {
      const { pdfText } = await import('../server/pdf-text.mjs');
      const text = await pdfText(await fetcher.pdf(act.pdf));
      const ru = R.parseRuling(text);
      console.log(`текст: ${text.length} симв.; резолютивная часть найдена: ${ru.hasResolution}; по ней: ${ru.kindHint}`);
      console.log(ru.resolution.slice(0, 1800));
    } catch (e) { console.log('PDF не загружен:', e.message); }
  }
} catch (e) {
  failed = true;
  console.log('ОШИБКА:', e.message);
} finally {
  await fetcher.close();
}
process.exit(failed ? 1 : 0);
