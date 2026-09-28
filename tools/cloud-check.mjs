/*
 * Облачная проверка споров — в GitHub Actions, без своего сервера.
 *
 * Отслеживаемый спор — открытая задача (issue) этого репозитория, в которой
 * есть ссылка на карточку kad.arbitr и дата подачи заявления. Проверка:
 *   — загружает карточку и тексты определений спора тем же загрузчиком, что
 *     и server.mjs, и разбирает тем же кодом, что и страница;
 *   — кладёт результат в папку data/ сайта (ветка gh-pages): data/<номер
 *     задачи>.json и сводку data/index.json — их показывает сайт;
 *   — о новых документах пишет комментарий в задачу, а GitHub присылает
 *     уведомление на почту и в приложение.
 * Закрытая задача — спор снят с отслеживания.
 *
 * node tools/cloud-check.mjs --site <папка ветки gh-pages> [--issue N]
 * Нужны GITHUB_TOKEN и GITHUB_REPOSITORY — в Actions они есть всегда.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KadFetcher } from '../server/kad-fetch.mjs';
import { pdfText } from '../server/pdf-text.mjs';
import { chooseText } from '../server/card-text.mjs';
import '../src/dates.js';
import '../src/kad.js';
import '../src/rules.js';
import '../src/dispute.js';

const { KadCard: C, KadDispute: X, KadDates: D, KadRules: R } = globalThis;

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SITE = path.resolve(arg('--site') || 'site');
const ONLY = arg('--issue') ? +arg('--issue') : null;
// Проверка по просьбе в комментарии: ответить и тогда, когда нового нет.
const REPLY = process.argv.includes('--reply');
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
const DATA = path.join(SITE, 'data');
const KAD_CARD = new RegExp(`https?://(?:www\\.)?kad\\.arbitr\\.ru/Card/${C.GUID}`, 'i');

const [OWNER, NAME] = REPO.split('/');
export const siteUrl = (owner, name) => name.toLowerCase() === `${owner.toLowerCase()}.github.io`
  ? `https://${owner.toLowerCase()}.github.io/`
  : `https://${owner.toLowerCase()}.github.io/${name}/`;

const log = (...a) => console.log(...a);
const isAct = (e) => !e.rec.synthetic && /^(?:ruling|decision|appealRuling|protocol|courtDoc)$/.test(e.cls.nature || '');

/* ---------- GitHub ---------- */

async function gh(p, opts = {}) {
  const r = await fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json', 'User-Agent': 'kadmonitoring', ...(opts.headers || {})
    }
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status} ${p}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

async function openIssues() {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const list = await gh(`/repos/${REPO}/issues?state=open&per_page=100&page=${page}`);
    out.push(...list.filter((i) => !i.pull_request));
    if (list.length < 100) break;
  }
  return out;
}

async function comment(issue, body) {
  try {
    await gh(`/repos/${REPO}/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  } catch (e) {
    log(`комментарий в задачу #${issue.number} не отправлен: ${e.message}`);
  }
}

/* ---------- задача → спор ---------- */

const placeholder = (s) => !s || /^\(?необязательно|^[-—.]*$/i.test(s.trim());

/** Ссылка на карточку, дата подачи и уточнения из заголовка и текста задачи. */
export function parseIssue(issue) {
  const text = `${issue.title || ''}\n${issue.body || ''}`;
  const url = (text.match(KAD_CARD) || [''])[0];
  if (!url) return null;
  const field = (re) => { const m = text.match(re); return m && !placeholder(m[1]) ? m[1].trim() : ''; };
  const filed = D.find(field(/дата\s+подачи[^:\n]*:[ \t]*([^\n]+)/i)) ||
    D.find(field(/заявлени[еяю]\s+от\s+([^\n]+)/i)) ||
    D.find(text.replace(KAD_CARD, ''));
  const role = field(/роль[^:\n]*:[ \t]*([^\n]+)/i);
  return {
    url,
    filed,
    applicant: field(/заявитель[^:\n]*:[ \t]*([^\n]+)/i),
    role: /заявител/i.test(role) ? 'applicant' : /участник/i.test(role) ? 'participant' : '',
    subject: field(/предмет[^:\n]*:[ \t]*([^\n]+)/i)
  };
}

/* ---------- проверка ---------- */

function analyze(st, known) {
  const card = st.card && st.card.raw ? C.parse(st.card.raw, { html: st.card.html }) : { meta: {}, records: [] };
  const d = X.build(card, {
    filedDate: st.filed, applicant: st.applicant, role: st.role, hearing: st.hearing, subject: st.subject,
    texts: st.texts || {}, rootId: st.rootId, include: st.include, exclude: st.exclude, known
  });
  return { card, d, summary: { ...X.summary(d), debtor: card.meta.debtor || '' } };
}

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const write = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj), 'utf8');

async function check(issue, spec, fetcher) {
  const file = path.join(DATA, `${issue.number}.json`);
  const prev = read(file);
  const st = {
    ...(prev || {}),
    app: 'kadmonitoring', v: 1, id: String(issue.number), issue: issue.number, title: issue.title,
    filed: spec.filed, url: spec.url, applicant: spec.applicant, role: spec.role, subject: spec.subject,
    texts: (prev && prev.texts) || {}, include: (prev && prev.include) || [], exclude: (prev && prev.exclude) || [],
    closed: false
  };
  // Спор поменяли в задаче (другая карточка или дата) — считаем заново.
  const same = prev && prev.url === spec.url && prev.filed === spec.filed;
  const known = same && prev.known ? prev.known : null;

  try {
    const r = await fetcher.card(spec.url);
    const got = chooseText(r, spec.url);
    st.card = { raw: got.text, html: false, source: 'kad.arbitr', at: r.at };
    let a = analyze(st, known);

    // Тексты актов спора — один раз: судебный акт после публикации не меняется.
    const todo = a.d.events.filter((e) => isAct(e) && e.rec.pdf && !st.texts[e.rec.id]).slice(-8);
    for (const e of todo) {
      try {
        const text = await pdfText(await fetcher.pdf(e.rec.pdf));
        if (text) st.texts[e.rec.id] = text;
        log(`  текст акта от ${D.fmt(e.rec.date)}: ${text.length} симв.`);
      } catch (err) {
        log(`  текст акта от ${D.fmt(e.rec.date)} не загружен: ${err.message}`);
      }
    }
    if (todo.length) a = analyze(st, known);

    const fresh = known ? a.d.events.filter((e) => e.isNew) : [];
    Object.assign(st, {
      known: a.d.events.map((e) => e.rec.id),
      checkedAt: new Date().toISOString(),
      error: null,
      note: got.note,
      summary: a.summary
    });
    const first = !prev || !prev.announced || !same;
    st.announced = true;
    write(file, st);
    log(`#${issue.number} ${a.summary.caseNo}: ${a.summary.stageLabel}; документов в споре ${a.d.events.length}; новых ${fresh.length}`);
    if (first) await comment(issue, report(st, a, null));
    else if (fresh.length) await comment(issue, report(st, a, fresh));
    else if (REPLY) await comment(issue, `Проверено: новых документов в споре нет. Стадия — ${a.summary.stageLabel.toLowerCase()}. [Открыть спор на сайте](${siteUrl(OWNER, NAME)}#c=${st.issue})`);
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    log(`#${issue.number}: ошибка — ${msg}`);
    Object.assign(st, { checkedAt: new Date().toISOString(), error: msg });
    write(file, st);
    // Об ошибке — один раз, а не при каждой проверке по расписанию.
    if (!prev || prev.error !== msg) await comment(issue, `Не удалось проверить карточку: ${msg}\n\nПроверка повторится по расписанию.`);
  }
}

/* ---------- сообщение в задачу ---------- */

function report(st, a, fresh) {
  const s = a.summary;
  const d = a.d;
  const link = `${siteUrl(OWNER, NAME)}#c=${st.issue}`;
  const out = [];
  out.push(fresh
    ? `### Новые документы в споре: ${fresh.length}`
    : '### Спор на отслеживании');
  out.push(`**${s.caseNo || 'Дело'}** · заявление от ${D.fmt(st.filed)}${d.root && d.root.from ? ` · ${d.root.from}` : ''}`);
  if (fresh) {
    out.push(fresh.map((e) => `- ${D.fmt(e.rec.date)} — ${e.cls.doc}${e.rec.pdf ? ` ([PDF](${e.rec.pdf}))` : ''}`).join('\n'));
  }
  const st2 = d.stage ? R.STAGES[d.stage] : null;
  out.push(`**Стадия:** ${s.stageLabel}${st2 ? ` — ${st2.note.toLowerCase()}` : ''}.` +
    (s.lastEvent ? `\n**Последнее событие:** ${s.lastEvent.doc} от ${D.fmt(s.lastEvent.date)}.` : '') +
    `\n**Заседание:** ${s.hearing ? `${D.fmt(s.hearing.date)}${s.hearing.time ? ' ' + s.hearing.time : ''}` : 'дата неизвестна'}.`);
  const open = d.tasks.filter((t) => !t.done).slice(0, 6);
  if (open.length) {
    out.push('**Что требуется от финансового управляющего:**\n' + open.map((t) =>
      `- ${t.due ? `**до ${D.fmt(t.due.date)}${t.due.approximate ? ' ≈' : ''}**` : '*без срока*'} — ${t.what.length > 320 ? t.what.slice(0, 320) + '…' : t.what} _(${t.norm})_` +
      (t.dueNote ? `\n  ${t.dueNote}` : '')).join('\n'));
  }
  if (!fresh) {
    out.push(`<details><summary>Документы спора: ${d.events.length}</summary>\n\n` +
      d.events.map((e) => `- ${D.fmt(e.rec.date)} — ${e.cls.doc}`).join('\n') + '\n</details>');
  }
  out.push(`[Открыть спор на сайте](${link}) · карточка проверяется по расписанию; чтобы проверить сейчас, напишите в комментарии «проверить». Закройте задачу, чтобы снять спор с отслеживания.`);
  out.push('<sub>Выводы программы — не юридическая консультация: сверяйтесь с текстом определения.</sub>');
  return out.join('\n\n');
}

/* ---------- сводка для сайта ---------- */

function writeIndex() {
  const items = fs.readdirSync(DATA).filter((f) => /^\d+\.json$/.test(f))
    .map((f) => read(path.join(DATA, f))).filter((st) => st && !st.closed)
    .map((st) => ({ id: st.id, issue: st.issue, title: st.title, filed: st.filed, url: st.url,
      checkedAt: st.checkedAt || null, error: st.error || null, summary: st.summary || {} }))
    .sort((a, b) => b.issue - a.issue);
  write(path.join(DATA, 'index.json'), {
    app: 'kadmonitoring', repo: REPO, updatedAt: new Date().toISOString(),
    schedule: process.env.KAD_SCHEDULE || '', items
  });
  log(`сводка: ${items.length} споров`);
}

function markClosed(n) {
  const file = path.join(DATA, `${n}.json`);
  const st = read(file);
  if (st && !st.closed) { st.closed = true; write(file, st); log(`#${n}: задача закрыта — спор снят с отслеживания`); }
}

/* ---------- главное ---------- */

async function main() {
  if (!REPO || !TOKEN) throw new Error('нужны GITHUB_REPOSITORY и GITHUB_TOKEN');
  fs.mkdirSync(DATA, { recursive: true });
  const issues = ONLY ? [await gh(`/repos/${REPO}/issues/${ONLY}`)] : await openIssues();
  const fetcher = new KadFetcher({ profileDir: path.join(os.tmpdir(), 'kad-profile'), log });
  const seen = new Set();
  try {
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const spec = parseIssue(issue);
      if (!spec) continue;
      seen.add(issue.number);
      if (issue.state === 'closed') { markClosed(issue.number); continue; }
      if (!spec.filed) {
        const file = path.join(DATA, `${issue.number}.json`);
        if (!(read(file) || {}).askedDate) {
          await comment(issue, 'Не нашёл дату подачи заявления. Добавьте в задачу строку «Дата подачи: дд.мм.гггг» — проверка начнётся сама.');
          write(file, { id: String(issue.number), issue: issue.number, title: issue.title, url: spec.url, askedDate: true, closed: false,
            error: 'не указана дата подачи', summary: {} });
        }
        continue;
      }
      log(`#${issue.number}: ${spec.url}, заявление от ${D.fmt(spec.filed)}`);
      await check(issue, spec, fetcher);
    }
  } finally {
    await fetcher.close();
  }
  // Полная проверка знает все открытые задачи: остальные споры сняты.
  if (!ONLY) {
    for (const f of fs.readdirSync(DATA).filter((x) => /^\d+\.json$/.test(x))) {
      const n = +f.slice(0, -5);
      if (!seen.has(n)) markClosed(n);
    }
  }
  writeIndex();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
