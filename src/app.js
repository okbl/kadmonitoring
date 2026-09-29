/*
 * Логика страницы. Наружу ничего не выставляет.
 *
 * Режимов три. Страница без хранилища (файл с диска, GitHub Pages) работает
 * только со вставкой и хранит спор в скачанном файле. Страница расширения
 * браузера и страница локального сервера (server.mjs) вдобавок загружают
 * карточку по ссылке, тексты определений из PDF и держат список
 * отслеживаемых споров — на устройстве пользователя, не где-то ещё.
 * Разбор, правила и сроки в обоих режимах одни и те же и считаются здесь,
 * в браузере; сервер только приносит данные и хранит их.
 */
(function () {
  'use strict';

  const D = globalThis.KadDates;
  const C = globalThis.KadCard;
  const R = globalThis.KadRules;
  const X = globalThis.KadDispute;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const KAD_URL = new RegExp(`^https?://(?:www\\.)?kad\\.arbitr\\.ru/Card/(${C.GUID})`, 'i');
  const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

  /* Состояние спора — ровно то, что сохраняется в файл или на сервер. */
  const blank = () => ({
    app: 'kadmonitoring', v: 1, id: null,
    filed: null, url: '',
    card: { raw: '', html: false, source: '', at: '' },
    applicant: '', role: '', hearing: null, subject: '',
    texts: {}, rootId: null, include: [], exclude: [], known: null
  });

  let S = blank();
  let viewKnown = null;    // «новое» считается от того, что было известно при открытии
  let card = null;
  let dispute = null;
  const opened = new Set();  // раскрытые события переживают перерисовку

  /* ---------- мелочи ---------- */

  function echo(id, text, bad) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('bad', !!bad);
  }

  let toastTimer = 0;
  function toast(text) {
    let el = $('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.append(el); }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function busy(btn, text) {
    const was = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    btn.classList.add('busy');
    return () => { btn.textContent = was; btn.disabled = false; btn.classList.remove('busy'); };
  }

  const dayWord = (n) => D.plural(n, 'день', 'дня', 'дней');
  const docWord = (n) => D.plural(n, 'документ', 'документа', 'документов');

  function leftText(date) {
    const n = D.until(date);
    if (n < 0) return `истёк ${D.days(n)} назад`;
    if (n === 0) return 'сегодня';
    if (n === 1) return 'завтра';
    return `через ${D.days(n)}`;
  }

  /* ---------- ввод даты ---------- */

  const dateInput = $('dateInput');

  function readDate() {
    const v = dateInput.value.trim();
    dateInput.classList.remove('bad');
    if (!v) { S.filed = null; echo('dateEcho', ''); return; }
    const d = D.parse(v);
    if (!d) {
      S.filed = null;
      dateInput.classList.add('bad');
      echo('dateEcho', 'Не похоже на дату — нужно дд.мм.гггг', true);
      return;
    }
    S.filed = d;
    const ago = D.diff(d, D.today());
    echo('dateEcho', `${D.fmtLong(d)}, ${WEEKDAYS[D.weekday(d) - 1]}` +
      (ago > 0 ? ` · ${ago} ${dayWord(ago)} назад` : ago < 0 ? ' · дата в будущем — проверьте' : ' · сегодня'), ago < 0);
  }

  dateInput.addEventListener('input', (e) => {
    let v = dateInput.value;
    // 23062026 → 23.06.2026; точки подставляются по ходу набора.
    if (/^\d{8}$/.test(v)) v = `${v.slice(0, 2)}.${v.slice(2, 4)}.${v.slice(4)}`;
    else if (e.inputType === 'insertText' && /^\d{2}$|^\d{2}\.\d{2}$/.test(v)) v += '.';
    if (v !== dateInput.value) dateInput.value = v;
    readDate();
  });
  dateInput.addEventListener('change', () => {
    readDate();
    if (S.filed) dateInput.value = D.fmt(S.filed);
    rerun();
  });
  dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dateInput.dispatchEvent(new Event('change')); });

  $('datePick').addEventListener('click', () => {
    const nat = $('dateNative');
    nat.value = S.filed || D.today();
    try { nat.showPicker(); } catch (_) { nat.focus(); nat.click(); }
  });
  $('dateNative').addEventListener('change', (e) => {
    if (!e.target.value) return;
    dateInput.value = D.fmt(e.target.value);
    dateInput.dispatchEvent(new Event('change'));
  });

  /* ---------- ссылка на карточку ---------- */

  function readUrl() {
    const v = $('urlInput').value.trim();
    S.url = v;
    const m = v.match(KAD_URL);
    $('urlOpen').hidden = !m;
    if (m) $('urlOpen').href = `https://kad.arbitr.ru/Card/${m[1]}`;
    $('btnFetch').disabled = !m;
    if (!v) echo('urlEcho', backend ? 'Вставьте ссылку — карточка загрузится сама' : '');
    else if (!m) echo('urlEcho', 'Ожидается ссылка вида https://kad.arbitr.ru/Card/…', true);
    else echo('urlEcho', card && card.meta.caseNo ? `Дело ${card.meta.caseNo}` : 'Ссылка на карточку дела');
  }
  $('urlInput').addEventListener('input', readUrl);
  $('urlInput').addEventListener('change', () => { readUrl(); scheduleSave(); });
  $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && backend && KAD_URL.test(S.url)) fetchCard(); });

  /* ---------- вставка и файлы ---------- */

  function setCard(raw, html, source, at) {
    S.card = { raw, html: !!html, source, at: at || new Date().toISOString() };
    $('paste').value = html ? C.lines(C.htmlToText(raw)).join('\n') : raw;
  }

  $('paste').addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    const html = cd && cd.getData('text/html');
    // HTML лучше текста: в нём ссылки на PDF и границы блоков.
    if (html && html.length > 400) {
      e.preventDefault();
      setCard(html, true, 'вставка');
      setTimeout(run, 0);
    } else {
      setTimeout(() => { setCard($('paste').value, false, 'вставка'); run(); }, 0);
    }
  });
  $('paste').addEventListener('input', (e) => {
    if (e.inputType === 'insertFromPaste') return;
    S.card = { raw: $('paste').value, html: false, source: 'вставка', at: new Date().toISOString() };
  });

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await loadFile(f);
  });

  async function loadFile(f) {
    const name = f.name.toLowerCase();
    try {
      if (name.endsWith('.json')) return openState(JSON.parse(await f.text()));
      if (/\.mht(ml)?$/.test(name)) setCard(mhtmlToHtml(await f.arrayBuffer()), true, `файл ${f.name}`);
      else if (/\.html?$/.test(name)) setCard(await f.text(), true, `файл ${f.name}`);
      else setCard(await f.text(), false, `файл ${f.name}`);
      run();
    } catch (err) {
      echo('pasteEcho', `Не удалось прочитать ${f.name}: ${err.message}`, true);
    }
  }

  /**
   * .mhtml — письмо MIME с HTML внутри, обычно в quoted-printable. Байты
   * читаются через x-user-defined: эта кодировка обратима, и после разбора
   * заголовков тело декодируется в той кодировке, что в нём объявлена.
   */
  function mhtmlToHtml(buf) {
    const bin = new TextDecoder('x-user-defined').decode(new Uint8Array(buf));
    const byte = (ch) => ch.charCodeAt(0) & 0xff;
    const bm = bin.match(/boundary="?([^";\r\n]+)"?/i);
    const parts = bm ? bin.split('--' + bm[1]) : [bin];
    for (const p of parts) {
      const cut = p.search(/\r?\n\r?\n/);
      if (cut < 0) continue;
      const head = p.slice(0, cut);
      if (!/content-type:\s*text\/html/i.test(head)) continue;
      let body = p.slice(cut).replace(/^\r?\n\r?\n/, '');
      const enc = (head.match(/content-transfer-encoding:\s*([\w-]+)/i) || [])[1] || '';
      const cs = (head.match(/charset="?([\w-]+)"?/i) || [])[1] || 'utf-8';
      const out = [];
      if (/quoted-printable/i.test(enc)) {
        body = body.replace(/=\r?\n/g, '');
        for (let i = 0; i < body.length; i++) {
          if (body[i] === '=' && /^[0-9A-F]{2}$/i.test(body.substr(i + 1, 2))) { out.push(parseInt(body.substr(i + 1, 2), 16)); i += 2; }
          else out.push(byte(body[i]));
        }
      } else if (/base64/i.test(enc)) {
        for (const ch of atob(body.replace(/[^A-Za-z0-9+/=]/g, ''))) out.push(ch.charCodeAt(0));
      } else {
        for (const ch of body) out.push(byte(ch));
      }
      return new TextDecoder(cs).decode(new Uint8Array(out));
    }
    return new TextDecoder().decode(new Uint8Array(buf));
  }

  $('btnParse').addEventListener('click', () => {
    if (!S.card.html) S.card = { raw: $('paste').value, html: false, source: S.card.source || 'вставка', at: S.card.at || new Date().toISOString() };
    run();
  });
  $('btnClear').addEventListener('click', () => {
    S.card = { raw: '', html: false, source: '', at: '' };
    $('paste').value = '';
    echo('pasteEcho', '');
    run();
  });

  /* ---------- уточнения ---------- */

  $('applicantInput').addEventListener('change', (e) => { S.applicant = e.target.value.trim(); rerun(); });
  $('roleSelect').addEventListener('change', (e) => { S.role = e.target.value; rerun(); });
  $('subjectInput').addEventListener('change', (e) => { S.subject = e.target.value.trim(); rerun(); });
  $('hearingInput').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    const d = v ? D.parse(v) : null;
    e.target.classList.toggle('bad', !!v && !d);
    S.hearing = d;
    if (d) e.target.value = D.fmt(d);
    rerun();
  });

  function fillInputs() {
    dateInput.value = S.filed ? D.fmt(S.filed) : '';
    $('urlInput').value = S.url || '';
    $('applicantInput').value = S.applicant || '';
    $('roleSelect').value = S.role || '';
    $('hearingInput').value = S.hearing ? D.fmt(S.hearing) : '';
    $('subjectInput').value = S.subject || '';
    $('paste').value = S.card.raw ? (S.card.html ? C.lines(C.htmlToText(S.card.raw)).join('\n') : S.card.raw) : '';
    readDate();
    readUrl();
  }

  /* ---------- разбор ---------- */

  const spec = () => ({
    filedDate: S.filed, applicant: S.applicant, role: S.role, hearing: S.hearing, subject: S.subject,
    texts: S.texts, rootId: S.rootId, include: S.include, exclude: S.exclude, known: viewKnown
  });

  function rerun() { if (S.card.raw || S.filed) run(); }

  function run() {
    readDate();
    readUrl();
    if (!S.card.raw.trim() && !S.filed) {
      card = null; dispute = null;
      $('result').hidden = true;
      $('empty').hidden = false;
      $('btnSave').disabled = true;
      $('btnPrint').disabled = true;
      return;
    }
    card = S.card.raw.trim()
      ? C.parse(S.card.raw, { html: S.card.html })
      : { meta: {}, records: [], diagnostics: { source: 'нет', lines: 0, records: 0, head: [], withResponseTo: 0, withPdf: 0 } };
    dispute = X.build(card, spec());
    render();
    $('btnSave').disabled = false;
    $('btnPrint').disabled = false;
    scheduleSave();
    autoTrack();
  }

  /* ---------- отрисовка ---------- */

  function render() {
    const d = dispute;
    $('result').hidden = false;
    $('empty').hidden = true;

    const m = card.meta || {};
    const bits = [m.caseNo && `Дело ${m.caseNo}`, m.debtor && `должник ${m.debtor}`, m.court].filter(Boolean);
    $('caseLine').textContent = bits.length ? bits.join(' · ') : 'оспаривание сделки должника — движение по карточке kad.arbitr';
    document.title = m.caseNo ? `${m.caseNo} — обособленный спор` : 'Обособленный спор — движение оспаривания сделки должника';

    reportParse(d);
    renderTiles(d);
    renderTasks(d);
    renderTimeline(d);
    renderMaybe(d);
    renderDiag(d);
  }

  function reportParse(d) {
    if (!S.card.raw.trim()) {
      echo('pasteEcho', backend ? 'Карточка ещё не загружена — вставьте ссылку на неё' : 'Карточка не загружена — показано только то, что следует из даты подачи');
      return;
    }
    const g = card.diagnostics;
    if (!g.records) {
      echo('pasteEcho', 'В тексте не найдено ни одной записи с датой. Вставлена ли страница карточки целиком? Подробности — в «Проверке разбора».', true);
      return;
    }
    const when = S.card.at ? ` · ${S.card.source || 'вставка'} от ${D.fmt(S.card.at.slice(0, 10))}` : '';
    let msg = `В карточке ${g.records} ${docWord(g.records)}, к спору относятся ${d.events.length}${when}`;
    if (!g.withResponseTo) msg += '. Поля «В ответ на» нет ни у одного документа — связи не установить, проверьте «Возможно относится»';
    else if (!d.rootFound && d.root && d.root.inferred) msg += '. Самого заявления в хронологии картотеки нет — спор собран по ссылкам «В ответ на» на него';
    else if (!d.rootFound && S.filed) msg += '. Заявление от этой даты в карточке не найдено — возможно, оно ещё не опубликовано';
    echo('pasteEcho', msg, !g.withResponseTo);
  }

  const ROLE = {
    applicant: ['заявитель', 'Заявление подал управляющий: доказывание позиции и устранение недостатков — на нём.'],
    participant: ['участник', 'Заявление подал не управляющий, поэтому управляющий — участник спора: с него отзыв, документы по сделке и явка в заседание.'],
    unknown: ['не ясна', 'Кто подал заявление, из карточки не видно — показаны обязанности участника спора. Уточните роль в «Уточнениях».']
  };

  function renderTiles(d) {
    const st = d.stage ? R.STAGES[d.stage] : { label: 'Нет данных', tone: 'neutral', note: 'Заявление не найдено' };
    const heroCls = st.tone === 'ok' ? 'ok' : st.tone === 'neutral' ? 'neutral' : '';
    const today = D.today();
    const since = d.root ? D.diff(d.root.date, today) : null;
    const last = d.stageEvent;
    const lastText = last && last.confidence !== 'root'
      ? ` Последний судебный акт — <b>${esc(last.cls.doc.toLowerCase())}</b> от ${D.fmt(last.rec.date)}.`
      : d.root ? ` Заявление ${d.rootFound ? 'зарегистрировано' : 'подано'} ${D.fmt(d.root.date)}${d.rootFound ? '' : ', в карточке его пока нет'}.` : '';

    const hero = `<div class="t hero ${heroCls}">
      <div class="k">Стадия спора</div>
      <div class="big">${esc(st.label)}</div>
      <p class="said">${esc(st.note)}.${lastText}</p>
      <div class="strip">
        <div><b>${d.root ? D.fmt(d.root.date) : '—'}</b>подано заявление</div>
        <div><b>${since != null && since >= 0 ? since : '—'}</b>${since != null && since >= 0 ? dayWord(since) + ' с подачи' : 'дней с подачи'}</div>
        <div><b>${d.events.length}</b>${docWord(d.events.length)} в споре</div>
        <div><b>${ROLE[d.role][0]}</b>роль управляющего</div>
      </div>
    </div>`;

    const h = d.hearing;
    let hTile;
    if (h) {
      const n = D.until(h.date);
      const cls = n < 0 ? '' : n <= 7 ? 'warnT' : 'okT';
      const note = n >= 0 ? leftText(h.date)
        : X.CLOSED.has(d.stage) ? `прошло ${D.days(n)} назад — последнее известное заседание`
        : `прошло ${D.days(n)} назад — ждём судебный акт по его итогам`;
      hTile = `<div class="t ${cls}"><div class="k">Судебное заседание</div>
        <div class="v">${D.fmt(h.date)}${h.time ? ` <span style="font-size:17px;font-weight:600">${esc(h.time)}</span>` : ''}</div>
        <div class="m">${esc(note)} · ${esc(h.source)}${h.text ? ` · ${esc(h.text)}` : ''}</div></div>`;
    } else {
      hTile = `<div class="t"><div class="k">Судебное заседание</div><div class="v">—</div>
        <div class="m">Дата неизвестна: её нет ни в карточке, ни в тексте определения. Её можно указать в «Уточнениях».</div></div>`;
    }

    const open = d.tasks.filter((t) => !t.done);
    const next = open.find((t) => t.due && t.due.date >= today);
    const late = open.filter((t) => t.due && t.due.date < today);
    let dTile;
    if (next || late.length) {
      const warn = late.length || (next && D.until(next.due.date) <= 3);
      dTile = `<div class="t ${warn ? 'warnT' : ''}"><div class="k">Ближайший срок</div>
        <div class="v">${next ? D.fmt(next.due.date) : 'просрочено'}</div>
        <div class="m">${next ? esc(leftText(next.due.date)) + ' · ' + esc(next.what.slice(0, 110)) + (next.what.length > 110 ? '…' : '') : ''}
        ${late.length ? `<br><b style="color:var(--acc)">Сроков истекло: ${late.length}</b> — проверьте, исполнены ли` : ''}</div></div>`;
    } else {
      dTile = `<div class="t"><div class="k">Ближайший срок</div><div class="v">—</div>
        <div class="m">Сроков с известной датой нет.</div></div>`;
    }

    $('tiles').innerHTML = hero + `<div class="stack">${hTile}${dTile}</div>`;
  }

  function renderTasks(d) {
    const anchor = d.tasks.length ? d.tasks.map((t) => t.from.date).sort()[0] : null;
    $('tasksLead').innerHTML = esc(ROLE[d.role][1]) +
      (d.role !== 'unknown' && d.root && d.root.from ? ` Заявитель: ${esc(d.root.from)}.` : '') +
      (anchor ? ` Учтены события с ${D.fmt(anchor)}: более ранние обязанности либо исполнены, либо перекрыты последующими актами.` : '');

    if (!d.tasks.length) {
      $('tasks').innerHTML = '<div class="note">Сейчас от управляющего по этому спору ничего не требуется. Следующее событие — судебный акт; он появится в карточке.</div>';
    } else {
      $('tasks').innerHTML = d.tasks.map(taskHtml).join('');
    }
    const approx = d.tasks.some((t) => t.due && t.due.approximate);
    $('tasksNote').innerHTML = 'Сроки в днях — рабочие дни: нерабочие в такой срок не включаются, течение начинается со следующего дня (ч. 3, 4 ст. 113 АПК РФ).' +
      (approx ? ' <b>≈</b> — внутри срока есть праздники, а переносы выходных на этот год программе неизвестны: сверьте дату с производственным календарём.' : '');
  }

  function taskHtml(t) {
    let cls = '';
    let when = 'Без срока';
    let left = '';
    if (t.due && t.due.date) {
      const n = D.until(t.due.date);
      when = D.fmt(t.due.date) + (t.due.approximate ? ' ≈' : '');
      left = leftText(t.due.date);
      cls = n < 0 ? 'due-late' : n <= 5 ? 'due-soon' : 'due-ok';
    }
    if (t.done) cls = 'done';
    const tags = [`<span class="tag norm">${esc(t.norm)}</span>`,
      `<span class="tag">${esc(t.from.title)} от ${D.fmt(t.from.date)}</span>`];
    if (t.fromText) tags.push('<span class="tag src">из текста определения</span>');
    if (t.due && t.due.text) tags.push(`<span class="tag">${esc(t.due.text)}</span>`);
    return `<div class="task ${cls}">
      <div class="head"><span class="when">${esc(when)}</span>${left ? `<span class="left">${esc(left)}</span>` : ''}</div>
      <div class="what">${esc(t.what)}</div>
      ${t.dueNote ? `<div class="m" style="margin-top:5px">${esc(t.dueNote)}</div>` : ''}
      ${t.due && t.due.quote ? `<blockquote>${esc(t.due.quote)}</blockquote>` : ''}
      ${t.done ? `<div class="donebox">Похоже, выполнено: ${esc(t.done.doc)} от ${D.fmt(t.done.date)}</div>` : ''}
      <div class="foot">${tags.join('')}</div>
    </div>`;
  }

  const CONF = {
    root: ['root', 'заявление спора'],
    exact: ['exact', 'связь точная'],
    likely: ['likely', 'связь вероятная'],
    manual: ['likely', 'включено вручную']
  };

  const isAct = (e) => !e.rec.synthetic && /^(?:ruling|decision|appealRuling|protocol|courtDoc)$/.test(e.cls.nature || '');

  function renderTimeline(d) {
    const fresh = d.events.filter((e) => e.isNew).length;
    $('tlLead').textContent = d.events.length
      ? `Документы, которые картотека связала с заявлением полем «В ответ на» — напрямую или через другие документы спора.` +
        (fresh ? ` Новых с прошлого просмотра: ${fresh}.` : '') + ' Раскройте событие, чтобы увидеть основание связи и разбор текста.'
      : 'Документов спора не найдено.';
    $('timeline').innerHTML = d.events.map(evHtml).join('');
  }

  function evHtml(e) {
    const r = e.rec;
    const conf = CONF[e.confidence] || CONF.likely;
    const badges = [];
    if (e.isNew) badges.push('<span class="b new">новое</span>');
    if (e.stage) badges.push(`<span class="b stage">${esc(R.STAGES[e.stage].label)}</span>`);
    badges.push(`<span class="b ${conf[0]}">${conf[1]}</span>`);
    if (e.ruling) badges.push('<span class="b">текст разобран</span>');
    if (r.synthetic) badges.push(r.inferred
      ? '<span class="b">восстановлено по ссылкам</span>'
      : '<span class="b likely">в карточке пока нет</span>');

    const rows = [];
    const row = (label, value) => { if (value) rows.push(`<div class="lbl">${label}</div><p>${value}</p>`); };
    if (!r.synthetic) row('В карточке', esc(C.title(r)));
    row(isAct(e) ? 'Судья' : 'Подал', esc(r.from || r.applicant || r.judge || ''));
    row('В ответ на', esc(r.responseTo || (r.responseToId ? `документ ${r.responseToId}` : '')));
    if (e.confidence !== 'root') row('Почему отнесён к спору', esc(e.reasons.join('; ')));
    row('Заседание', esc(r.hearingInfo || ''));
    row('Публикация', esc(r.published || ''));
    if (r.extra && r.extra.length) row('Подробности', r.extra.map(esc).join('<br>'));
    if (r.pdf) row('Документ', `<a href="${esc(r.pdf)}" target="_blank" rel="noopener noreferrer">открыть PDF на kad.arbitr</a>`);

    let text = '';
    if (isAct(e)) {
      text = `<div class="lbl">Текст определения</div>
        <textarea data-text="${esc(r.id)}" placeholder="Вставьте текст судебного акта — программа найдёт сроки, дату заседания и поручения управляющему">${esc(S.texts[r.id] || '')}</textarea>
        <div class="acts noprint">
          <button class="btn btn-sm" data-act="text" data-id="${esc(r.id)}">Разобрать текст</button>
          ${r.pdf ? `<button class="btn btn-sm srv" data-act="pdf" data-id="${esc(r.id)}">Загрузить текст из PDF</button>` : ''}
          ${S.texts[r.id] ? `<button class="linkbtn" data-act="untext" data-id="${esc(r.id)}">убрать текст</button>` : ''}
        </div>
        ${e.ruling ? rulingHtml(e.ruling) : ''}`;
    }

    const acts = [];
    if (e.confidence === 'manual') acts.push(`<button class="btn btn-sm" data-act="uninclude" data-id="${esc(r.id)}">Убрать из спора</button>`);
    else if (e.confidence !== 'root') acts.push(`<button class="btn btn-sm" data-act="exclude" data-id="${esc(r.id)}">Не относится к спору</button>`);

    return `<details class="ev" data-ev="${esc(r.id)}"${opened.has(r.id) ? ' open' : ''}>
      <summary>
        <div class="date">${D.fmt(r.date)}</div>
        <div class="body">
          <div class="doc">${esc(e.cls.doc)}</div>
          <div class="sub">${esc(r.synthetic ? (r.from || 'заявитель не указан') : [C.title(r), r.from].filter(Boolean).join(' · '))}</div>
          <div class="badges">${badges.join('')}</div>
        </div>
      </summary>
      <div class="detail">${rows.join('')}${text}${acts.length ? `<div class="acts noprint">${acts.join('')}</div>` : ''}</div>
    </details>`;
  }

  function rulingHtml(ru) {
    const items = [];
    if (!ru.hasResolution) items.push('<li>Резолютивная часть («определил:») не найдена — разобран весь текст.</li>');
    if (ru.kindHint) {
      const k = R.RULING_KINDS.find((x) => x.kind === ru.kindHint);
      if (k) items.push(`<li>По резолютивной части: <b>${esc(k.doc.toLowerCase())}</b></li>`);
    }
    if (ru.hearing) items.push(`<li>Заседание: <b>${D.fmt(ru.hearing.date)}${ru.hearing.time ? ' в ' + esc(ru.hearing.time) : ''}</b> — «${esc(ru.hearing.quote)}»</li>`);
    for (const dl of ru.deadlines) items.push(`<li>Срок: <b>${dl.date ? D.fmt(dl.date) : `${dl.days} ${dl.calendar ? 'календ.' : 'раб.'} дн.`}</b> — «${esc(dl.quote)}»</li>`);
    for (const dm of ru.demands) {
      const to = dm.toFinancialManager ? '<b>Управляющему:</b> ' : dm.toAll ? '<b>Всем участникам:</b> ' : dm.toApplicant ? 'Заявителю: ' : '';
      items.push(`<li>${to}${esc(dm.text)}</li>`);
    }
    if (!items.length) items.push('<li>Сроков, даты заседания и поручений в тексте не найдено.</li>');
    return `<ul class="rul">${items.join('')}</ul>`;
  }

  function renderMaybe(d) {
    const excluded = (S.exclude || []).map((id) => card.records.find((r) => r.id === id)).filter(Boolean);
    const maybe = d.maybe.filter((m) => !m.excluded);
    $('maybeSec').hidden = !maybe.length && !excluded.length;
    const rowHtml = (r, why, act, label) => `<div class="maybe-row">
      <div class="date">${D.fmt(r.date)}</div>
      <div style="flex:1 1 auto;min-width:0"><div>${esc(C.title(r))}</div>
        <div class="m">${esc([r.from, why].filter(Boolean).join(' · '))}</div></div>
      <button class="btn btn-sm noprint" data-act="${act}" data-id="${esc(r.id)}">${label}</button>
    </div>`;
    $('maybe').innerHTML = maybe.map((m) => rowHtml(m.rec, m.reasons.join('; '), 'include', 'Включить в спор')).join('') +
      (excluded.length ? `<div class="lbl" style="margin:14px 0 4px;font-size:11.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em">Исключены вручную</div>` +
        excluded.map((r) => rowHtml(r, '', 'unexclude', 'Вернуть')).join('') : '');
  }

  function renderDiag(d) {
    const g = card.diagnostics;
    const root = d.root;
    const cands = d.candidates.filter((c) => !root || c.id !== root.id).slice(0, 5);
    $('diag').innerHTML = `
      Источник: <code>${esc(g.source)}</code>${S.card.source ? ` (${esc(S.card.source)})` : ''} · строк ${g.lines} · записей ${g.records}
      · с «В ответ на» ${g.withResponseTo} · со ссылкой на PDF ${g.withPdf}<br>
      Не относятся к спору: ${d.unrelated} ${docWord(d.unrelated)}.<br>
      Заявление спора: ${root ? `<b>${D.fmt(root.date)} ${esc(C.title(root))}</b>${root.from ? ' · ' + esc(root.from) : ''}` : 'не определено'}
      ${d.rootManual ? ' — выбрано вручную <button class="linkbtn" data-act="rootauto">определять автоматически</button>' : root && root.synthetic ? ' — в карточке не найдено, взята дата подачи' : ' — выбрано по дате подачи и содержанию'}
      ${cands.length ? `<br>Другие заявления рядом с датой подачи:${cands.map((c) =>
        `<div class="cand">${D.fmt(c.date)} · ${esc(c.title)}${c.from ? ' · ' + esc(c.from) : ''}
        <button class="linkbtn" data-act="root" data-id="${esc(c.id)}">это заявление спора</button></div>`).join('')}` : ''}
      ${g.head.length ? `<br>Начало разобранного текста: ${g.head.slice(0, 8).map((l) => `<code>${esc(l.slice(0, 60))}</code>`).join(' ')}` : ''}`;
  }

  /* ---------- действия в движении спора ---------- */

  document.addEventListener('toggle', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.dataset.ev) return;
    if (el.open) opened.add(el.dataset.ev); else opened.delete(el.dataset.ev);
  }, true);

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    const act = b.dataset.act;
    const list = (k) => { S[k] = (S[k] || []).filter((x) => x !== id); };
    if (act === 'include') { list('exclude'); S.include = [...(S.include || []), id]; opened.add(id); }
    else if (act === 'uninclude') list('include');
    else if (act === 'exclude') { list('include'); S.exclude = [...(S.exclude || []), id]; }
    else if (act === 'unexclude') list('exclude');
    else if (act === 'root') { S.rootId = id; toast('Заявление спора выбрано вручную'); }
    else if (act === 'rootauto') S.rootId = null;
    else if (act === 'text') {
      const ta = document.querySelector(`textarea[data-text="${CSS.escape(id)}"]`);
      if (ta) setText(id, ta.value);
      opened.add(id);
    } else if (act === 'untext') { delete S.texts[id]; }
    else if (act === 'pdf') { await loadPdf(id, b); return; }
    else return;
    run();
  });

  document.addEventListener('change', (e) => {
    const ta = e.target.closest && e.target.closest('textarea[data-text]');
    if (!ta) return;
    setText(ta.dataset.text, ta.value);
    opened.add(ta.dataset.text);
    run();
  });

  function setText(id, value) {
    if (value && value.trim()) S.texts[id] = value.trim();
    else delete S.texts[id];
  }

  /* ---------- где живут споры: сервер на компьютере или расширение ---------- */

  /*
   * Два хранилища с одним устройством. Сервер (server.mjs) — споры в папке
   * data на компьютере, карточки загружает его браузер. Расширение — споры в
   * chrome.storage этого браузера, карточки загружает фоновая часть
   * расширения. И там и там данные остаются на устройстве пользователя;
   * наружу идут только запросы к kad.arbitr.ru.
   */
  async function api(path, opts) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `сервер ответил ${res.status}`);
    return data;
  }

  const Http = {
    kind: 'server',
    info: null,
    async init() {
      if (!/^https?:$/.test(location.protocol)) return null;
      const r = await fetch('/api/ping').catch(() => null);
      if (!r || !r.ok) return null;
      this.info = await r.json();
      return this;
    },
    card: (url) => api('/api/fetch', { method: 'POST', body: JSON.stringify({ url }) }),
    pdf: async (url) => (await api(`/api/pdf?url=${encodeURIComponent(url)}`)).text,
    list: () => api('/api/disputes'),
    get: (id) => api(`/api/disputes/${encodeURIComponent(id)}`),
    async save(st) {
      const body = JSON.stringify(st);
      const r = st.id
        ? await api(`/api/disputes/${encodeURIComponent(st.id)}`, { method: 'PUT', body })
        : await api('/api/disputes', { method: 'POST', body });
      return r.id;
    },
    remove: (id) => api(`/api/disputes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    refresh: (id) => api(`/api/disputes/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
    note() {
      const h = this.info && this.info.checkHours;
      return h ? `сервер проверяет карточки каждые ${h} ч` : 'плановая проверка выключена';
    }
  };

  /*
   * Идентификатор расширения — из открытого ключа в extension/manifest.json;
   * build.mjs сверяет его с ключом. По нему страница на сайте находит
   * установленное расширение.
   */
  const EXT_ID = 'hocagbfdoeocameodjbbceojgecjcijn';

  /*
   * Расширение: либо это его собственная страница, либо та же страница на
   * сайте программы — тогда расширение отвечает ей (externally_connectable).
   * В обоих случаях разговор идёт внутри браузера; споры хранит расширение.
   */
  const Ext = {
    kind: 'ext',
    settings: null,
    remote: false,
    async init() {
      const c = globalThis.chrome;
      if (!(c && c.runtime)) return null;
      if (!(c.runtime.id && c.storage && c.storage.local)) {
        if (!c.runtime.sendMessage) return null;
        this.remote = true;
        await this.send({ type: 'ping' });
      }
      this.settings = await this.send({ type: 'settings' });
      return this;
    },
    send(msg) {
      return new Promise((resolve, reject) => {
        const done = (r) => {
          const err = chrome.runtime.lastError;
          if (err || !r) reject(new Error(err ? 'расширение недоступно' : 'расширение не ответило'));
          else if (r.error) reject(new Error(r.error));
          else resolve(r);
        };
        try {
          if (this.remote) chrome.runtime.sendMessage(EXT_ID, msg, done);
          else chrome.runtime.sendMessage(msg, done);
        } catch (e) { reject(e); }
      });
    },
    card(url) { return this.send({ type: 'card', url }); },
    async pdf(url) { return (await this.send({ type: 'pdf', url })).text; },
    async list() { return (await this.send({ type: 'list' })).items; },
    async get(id) { return (await this.send({ type: 'get', id })).state; },
    // Сохраняет фоновая часть: там же поля проверки и сводка — одна запись на всех.
    async save(st) { return (await this.send({ type: 'save', state: st })).id; },
    remove(id) { return this.send({ type: 'remove', id }); },
    refresh(id) { return this.send({ type: 'check', id }); },
    note() {
      const h = this.settings && this.settings.checkHours;
      return h ? `карточки проверяются каждые ${h} ч, пока открыт браузер` : 'плановая проверка выключена';
    }
  };

  let backend = null;

  $('btnFetch').addEventListener('click', () => {
    if (backend) { fetchCard(); return; }
    $('install').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('install').classList.add('flash');
    setTimeout(() => $('install').classList.remove('flash'), 1600);
    toast('Загружать карточки по ссылке умеет расширение для браузера — установите его, это один раз');
  });

  /*
   * Вставили ссылку — карточка загружается сама, без кнопки. Дату можно
   * ввести и потом: разбор пересчитается.
   */
  let loading = false;
  let autoFor = '';
  $('urlInput').addEventListener('input', () => {
    const m = S.url.match(KAD_URL);
    if (!backend || !m || loading || autoFor === m[1]) return;
    autoFor = m[1];
    fetchCard();
  });

  async function fetchCard() {
    readUrl();
    if (!KAD_URL.test(S.url)) { toast('Нужна ссылка на карточку kad.arbitr.ru'); return; }
    if (loading) return;
    loading = true;
    autoFor = S.url.match(KAD_URL)[1];
    const done = busy($('btnFetch'), 'Загружаю…');
    echo('pasteEcho', 'Загружаю карточку с kad.arbitr.ru — все страницы хронологии; обычно это 5–60 секунд…');
    try {
      const r = await backend.card(S.url);
      setCard(r.text, false, r.source || 'kad.arbitr', r.at);
      run();
      if (r.note) toast(r.note);
      if (!S.filed) {
        echo('dateEcho', 'Укажите дату подачи заявления — по ней программа найдёт спор в карточке', true);
        dateInput.focus();
      }
      await loadActs();
    } catch (err) {
      echo('pasteEcho', `Карточку загрузить не удалось: ${err.message}.`, true);
      $('manual').open = true;
    } finally {
      loading = false;
      done();
    }
  }

  /** Тексты судебных актов спора, которых ещё нет, — по одному, чтобы не частить. */
  async function loadActs() {
    if (!backend || !dispute) return;
    if (backend.kind === 'ext' && !(backend.settings && backend.settings.pdfTexts)) return;
    const mine = S;
    const todo = dispute.events.filter((e) => isAct(e) && e.rec.pdf && !S.texts[e.rec.id]);
    let n = 0;
    for (const e of todo) {
      // Пользователь открыл другой спор — тексты этого ему не нужны.
      if (S !== mine) return;
      n++;
      echo('pasteEcho', `Загружаю тексты определений: ${n} из ${todo.length}…`);
      try {
        const text = await backend.pdf(e.rec.pdf);
        if (text) mine.texts[e.rec.id] = text;
      } catch (err) {
        toast(`Текст от ${D.fmt(e.rec.date)} не загружен: ${err.message}`);
      }
    }
    if (todo.length && S === mine) run();
  }

  async function loadPdf(id, btn) {
    const e = dispute && dispute.events.find((x) => x.rec.id === id);
    if (!e || !e.rec.pdf || !backend) return;
    const done = busy(btn, 'Загружаю…');
    try {
      const text = await backend.pdf(e.rec.pdf);
      if (!text) throw new Error('в PDF нет текстового слоя — это скан');
      S.texts[id] = text;
      opened.add(id);
      run();
    } catch (err) {
      toast(`Не удалось: ${err.message}`);
      done();
    }
  }

  /* ---------- хранение ---------- */

  function snapshot() {
    return {
      ...S,
      known: dispute ? dispute.events.map((e) => e.rec.id) : S.known,
      summary: dispute ? { ...X.summary(dispute), debtor: card.meta.debtor || '' } : null,
      savedAt: new Date().toISOString()
    };
  }

  function openState(obj) {
    if (!obj || obj.app !== 'kadmonitoring') throw new Error('это не файл спора');
    S = { ...blank(), ...obj, card: { ...blank().card, ...(obj.card || {}) } };
    for (const k of ['summary', 'savedAt', 'checkedAt', 'error', 'note', 'notified', 'createdAt']) delete S[k];
    viewKnown = S.known ? [...S.known] : null;
    opened.clear();
    fillInputs();
    run();
    // Всё, что показано сейчас, пользователь видел: «новым» оно было один раз.
    if (dispute) S.known = dispute.events.map((e) => e.rec.id);
  }

  function fileName() {
    const no = (card && card.meta.caseNo) || 'дело';
    return `Спор ${no} от ${S.filed ? D.fmt(S.filed) : 'без даты'}.json`.replace(/[\\/:*?"<>|]/g, '-');
  }

  function download(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  $('btnSave').addEventListener('click', async () => {
    if (!backend) { download(snapshot(), fileName()); return; }
    try {
      await saveTracked();
      toast('Спор сохранён и отслеживается');
    } catch (err) { toast(`Не сохранено: ${err.message}`); }
  });

  $('btnOpen').addEventListener('click', () => $('fileJson').click());
  $('fileJson').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      // Файл из «Скачать все споры» — несколько споров сразу.
      if (backend && obj && Array.isArray(obj.disputes)) {
        for (const st of obj.disputes) await backend.save({ ...st, id: null });
        toast(`Загружено споров: ${obj.disputes.length}`);
        showList();
        return;
      }
      if (backend) showForm();
      openState(obj);
      if (backend) { S.id = null; await saveTracked(); }
    } catch (err) { toast(`Не открыт: ${err.message}`); }
  });

  async function saveTracked() {
    const mine = S;
    mine.id = await backend.save(snapshot());
    if (S === mine && location.hash !== `#d=${mine.id}`) history.replaceState(null, '', `#d=${mine.id}`);
  }

  /* Дата есть, карточка загружена по ссылке — спор сразу ставится на отслеживание. */
  let tracking = null;
  function autoTrack() {
    if (!backend || S.id || tracking || !S.filed || S.card.source !== 'kad.arbitr') return;
    tracking = saveTracked()
      .then(() => toast('Спор поставлен на отслеживание — он в «Моих спорах»'))
      .catch((err) => toast(`Не сохранено: ${err.message}`))
      .finally(() => { tracking = null; });
  }

  /* Отслеживаемый спор сохраняется сам — после каждого изменения. */
  let saveTimer = 0;
  function scheduleSave() {
    if (!backend || !S.id) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveTracked().catch((err) => toast(`Не сохранено: ${err.message}`)), 700);
  }

  /* ---------- список споров ---------- */

  const when = (iso) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function showForm() {
    $('listSec').hidden = true;
    $('askSec').hidden = false;
    if (dispute) $('result').hidden = false; else $('empty').hidden = false;
  }

  async function showList() {
    $('listSec').hidden = false;
    $('askSec').hidden = true;
    $('result').hidden = true;
    $('empty').hidden = true;
    $('caseLine').textContent = 'оспаривание сделки должника — движение по карточке kad.arbitr';
    history.replaceState(null, '', location.pathname);
    $('list').innerHTML = '<div class="note">Загружаю список…</div>';
    try {
      renderList(await backend.list());
    } catch (err) {
      $('list').innerHTML = `<div class="note warn">Список не загружен: ${esc(err.message)}</div>`;
    }
  }

  function renderList(items) {
    $('listNote').textContent = backend.note();
    if (!items.length) {
      $('list').innerHTML = '<div class="note">Отслеживаемых споров пока нет. Нажмите «Новый спор», вставьте ссылку на карточку и укажите дату подачи заявления — карточка загрузится, а спор встанет на отслеживание сам.</div>';
      return;
    }
    $('list').innerHTML = items.map((it) => {
      const s = it.summary || {};
      const next = s.nextDue ? `${D.fmt(s.nextDue.date)} — ${s.nextDue.what}` : 'сроков с датой нет';
      const hearing = s.hearing ? `заседание ${D.fmt(s.hearing.date)}${s.hearing.time ? ' ' + s.hearing.time : ''}` : 'дата заседания неизвестна';
      return `<div class="drow" data-open="${esc(it.id)}">
        <div><b>${esc(s.caseNo || 'Дело без номера')}</b>
          <span class="s">${esc(s.debtor || '')}${s.debtor ? ' · ' : ''}заявление от ${it.filed ? D.fmt(it.filed) : '—'}</span></div>
        <div><span class="pill ${esc(s.tone || 'neutral')}">${esc(s.stageLabel || 'нет данных')}</span>
          <span class="s">${s.lastEvent ? `${esc(s.lastEvent.doc)} от ${D.fmt(s.lastEvent.date)}` : ''}</span></div>
        <div><span class="s">${esc(hearing)}</span>
          <span class="s ${s.overdue ? 'acc' : ''}">${s.overdue ? `истекло сроков: ${s.overdue} · ` : ''}${esc(next.slice(0, 120))}</span>
          <span class="s">${it.checkedAt ? `проверено ${when(it.checkedAt)}` : 'ещё не проверялось'}${it.error ? ` · <span style="color:var(--acc)">${esc(it.error)}</span>` : ''}</span></div>
        <div class="r">${s.newEvents ? `<span class="b new">новое: ${s.newEvents}</span>` : ''}
          <button class="btn btn-sm" data-check="${esc(it.id)}">Проверить</button>
          <button class="linkbtn" data-del="${esc(it.id)}">удалить</button></div>
      </div>`;
    }).join('');
  }

  $('list').addEventListener('click', async (e) => {
    if (e.target.closest('a')) return;
    const chk = e.target.closest('[data-check]');
    const del = e.target.closest('[data-del]');
    const row = e.target.closest('[data-open]');
    if (chk) {
      const done = busy(chk, 'Проверяю…');
      try { await backend.refresh(chk.dataset.check); await showList(); }
      catch (err) { toast(err.message); done(); }
      return;
    }
    if (del) {
      if (!confirm('Удалить спор из отслеживания? Сохранённые данные будут удалены.')) return;
      try { await backend.remove(del.dataset.del); await showList(); }
      catch (err) { toast(err.message); }
      return;
    }
    if (row) openTracked(row.dataset.open);
  });

  async function openTracked(id) {
    try {
      const obj = await backend.get(id);
      showForm();
      openState(obj);
      history.replaceState(null, '', `#d=${id}`);
      scheduleSave();
    } catch (err) {
      toast(`Спор не открыт: ${err.message}`);
      showList();
    }
  }

  $('btnList').addEventListener('click', showList);
  $('btnNew').addEventListener('click', () => {
    S = blank();
    viewKnown = null;
    card = null;
    dispute = null;
    opened.clear();
    fillInputs();
    echo('pasteEcho', '');
    $('result').hidden = true;
    showForm();
    history.replaceState(null, '', location.pathname);
    dateInput.focus();
  });
  $('btnCheckAll').addEventListener('click', async (e) => {
    const done = busy(e.target, 'Проверяю…');
    try {
      const items = await backend.list();
      for (const it of items) {
        e.target.textContent = `Проверяю ${items.indexOf(it) + 1} из ${items.length}…`;
        try { await backend.refresh(it.id); }
        catch (err) { toast(`${(it.summary && it.summary.caseNo) || it.id}: ${err.message}`); }
      }
    } finally { done(); showList(); }
  });

  /* Резервная копия: все споры одним файлом — перенести на другое устройство. */
  $('btnExport').addEventListener('click', async () => {
    try {
      const items = await backend.list();
      const disputes = [];
      for (const it of items) disputes.push(await backend.get(it.id));
      download({ app: 'kadmonitoring', v: 1, exportedAt: new Date().toISOString(), disputes },
        `Обособленные споры ${D.fmt(D.today())}.json`);
    } catch (err) { toast(`Не выгружено: ${err.message}`); }
  });
  $('btnImport').addEventListener('click', () => $('fileJson').click());

  /* ---------- настройки расширения ---------- */

  function renderSettings() {
    if (!backend || backend.kind !== 'ext') return;
    const st = backend.settings || {};
    $('setHours').value = String(st.checkHours || 0);
    $('setNotify').checked = !!st.notify;
    $('setPdf').checked = !!st.pdfTexts;
  }
  async function saveSettings(patch) {
    backend.settings = await backend.send({ type: 'settings', set: patch });
    renderSettings();
    $('listNote').textContent = backend.note();
  }
  $('setHours').addEventListener('change', (e) => saveSettings({ checkHours: +e.target.value }));
  $('setNotify').addEventListener('change', (e) => saveSettings({ notify: e.target.checked }));
  $('setPdf').addEventListener('change', (e) => saveSettings({ pdfTexts: e.target.checked }));

  /* ---------- прочее ---------- */

  $('btnHelp').addEventListener('click', () => $('help').showModal());
  $('helpClose').addEventListener('click', () => $('help').close());
  $('btnPrint').addEventListener('click', () => window.print());

  // В печать идут все события раскрытыми: на бумаге не кликнешь.
  let printOpen = [];
  window.addEventListener('beforeprint', () => {
    printOpen = [...document.querySelectorAll('details.ev:not([open])')];
    printOpen.forEach((d) => { d.open = true; });
  });
  window.addEventListener('afterprint', () => { printOpen.forEach((d) => { d.open = false; }); printOpen = []; });

  async function init() {
    backend = await Ext.init().catch(() => null) || await Http.init().catch(() => null);
    document.body.classList.toggle('server', !!backend);
    document.body.classList.toggle('ext', !!backend && backend.kind === 'ext');
    readUrl();
    if (!backend) return;
    renderSettings();
    const m = location.hash.match(/^#d=([\w-]+)$/);
    if (m) openTracked(m[1]);
    else showList();
  }

  init();
})();
