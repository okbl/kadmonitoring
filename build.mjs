/*
 * Сборка.
 *
 *   dist/index.html — страница в одном файле: разметка, стили, шрифт и
 *     скрипты внутри. Открывается с диска или с сайта, работает без
 *     интернета; карточку в неё вставляют вручную.
 *   dist/extension/ и dist/kad-spor-extension.zip — расширение браузера:
 *     та же страница плюс фоновая часть, которая сама загружает карточки
 *     kad.arbitr и хранит споры в этом браузере.
 *
 * Сервер (server.mjs) отдаёт страницу, собирая её на лету: правки в src/
 * видны после обновления страницы, без отдельного шага сборки.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => path.join(root, 'src', f);

/* Порядок важен: каждый следующий модуль опирается на предыдущие. */
const SCRIPTS = [
  ['DATES', 'dates.js'],
  ['CARD', 'kad.js'],
  ['RULES', 'rules.js'],
  ['DISPUTE', 'dispute.js'],
  ['APP', 'app.js']
];

/**
 * Страница. external — скрипты отдельными файлами: страницам расширения
 * встроенные скрипты запрещены (Content Security Policy Manifest V3).
 */
export function assemble({ external = false } = {}) {
  let html = fs.readFileSync(src('app.html'), 'utf8');

  const fontFile = path.join(root, 'src', 'fonts', 'onest.css');
  const font = fs.existsSync(fontFile)
    ? fs.readFileSync(fontFile, 'utf8')
    : '/* Шрифт Onest не скачан (npm run font) — используется системный */';
  // Функция вместо строки замены: в коде и base64 бывают «$&» и «$1».
  html = html.replace('/* @@FONT@@ */', () => font);

  for (const [mark, file] of SCRIPTS) {
    const slot = `<!-- @@${mark}@@ -->`;
    if (!html.includes(slot)) throw new Error(`в app.html нет места для ${file}: ${slot}`);
    const tag = external
      ? `<script src="${file}"></script>`
      : `<script>\n${fs.readFileSync(src(file), 'utf8').replace(/<\/script/gi, '<\\/script')}\n</script>`;
    html = html.replace(slot, () => tag);
  }
  return html;
}

/* ---------- расширение ---------- */

/* Файлы расширения, кроме страницы и значков. */
const EXT_FILES = {
  'background.js': path.join(root, 'extension', 'background.js'),
  'dates.js': src('dates.js'),
  'kad.js': src('kad.js'),
  'rules.js': src('rules.js'),
  'dispute.js': src('dispute.js'),
  'kad-items.js': src('kad-items.js'),
  'pdf-text.js': src('pdf-text.js'),
  'app.js': src('app.js'),
  'pdf.min.mjs': path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs'),
  'pdf.worker.min.mjs': path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
  'LICENSE-pdfjs.txt': path.join(root, 'node_modules', 'pdfjs-dist', 'LICENSE')
};

/**
 * Идентификатор расширения — из открытого ключа в manifest.json (поле key):
 * у распакованного расширения он тогда один и тот же на любом компьютере,
 * и страница на сайте находит расширение по нему (src/app.js, EXT_ID).
 */
export function extensionId(manifest = readManifest()) {
  const hash = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
  return [...hash.slice(0, 32)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
}

const readManifest = () => JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));

/**
 * Файлы расширения: { путь: Buffer }. Только для тестов: base — адрес
 * картотеки (макет вместо kad.arbitr.ru), site — адрес страницы, которой
 * расширение отвечает вместо сайта программы.
 */
export function extensionFiles({ base = '', site = '' } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = readManifest();
  manifest.version = pkg.version;
  if (base) manifest.host_permissions.push(`${new URL(base).origin}/*`);
  if (site) manifest.externally_connectable.matches.push(`${new URL(site).origin}/*`);
  const id = extensionId(manifest);
  if (!fs.readFileSync(src('app.js'), 'utf8').includes(`'${id}'`))
    throw new Error(`в src/app.js другой EXT_ID — должен быть '${id}' (из ключа в extension/manifest.json)`);

  const out = {};
  for (const [name, file] of Object.entries(EXT_FILES)) {
    if (!fs.existsSync(file)) {
      if (name.startsWith('LICENSE')) continue;
      throw new Error(`нет файла ${file} — выполните npm install`);
    }
    out[name] = fs.readFileSync(file);
  }
  out['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2));
  out['config.js'] = Buffer.from(`globalThis.KAD_CONFIG = ${JSON.stringify({ base: base || 'https://kad.arbitr.ru' })};\n`);
  out['app.html'] = Buffer.from(assemble({ external: true }));
  for (const size of [16, 32, 48, 128]) out[`icons/${size}.png`] = iconPng(size);
  return out;
}

export function writeDir(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, data] of Object.entries(files)) {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  }
}

/* ---------- значок ---------- */

/*
 * Значок рисуется здесь же, без картинок в репозитории: скруглённый квадрат
 * в цветах страницы (терракота → роза, как .mark) и три строки «документа».
 */
function iconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const rad = size * 0.24;
  const a1 = [0x8d, 0x32, 0x1f];
  const a2 = [0x7d, 0x40, 0x47];
  const bars = [[0.30, 0.70, 0.30], [0.30, 0.70, 0.47], [0.30, 0.58, 0.64]];
  const barH = Math.max(1, size * 0.085);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // без фильтра строки
    for (let x = 0; x < size; x++) {
      const dx = Math.max(rad - (x + 0.5), 0, (x + 0.5) - (size - rad));
      const dy = Math.max(rad - (y + 0.5), 0, (y + 0.5) - (size - rad));
      const cover = Math.max(0, Math.min(1, rad - Math.hypot(dx, dy) + 0.5));
      const t = (x + y) / (2 * size);
      let c = a1.map((v, i) => v + (a2[i] - v) * t);
      for (const [x0, x1, yc] of bars) {
        const inBar = x + 0.5 >= x0 * size && x + 0.5 <= x1 * size && Math.abs(y + 0.5 - yc * size) <= barH / 2;
        if (inBar) c = [251, 247, 242];
      }
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = Math.round(c[0]); raw[i + 1] = Math.round(c[1]); raw[i + 2] = Math.round(c[2]);
      raw[i + 3] = Math.round(cover * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- zip ---------- */

/* Архив для скачивания: папка folder/ со всеми файлами, сжатие deflate, имена в UTF-8. */
export function zip(files, folder) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name0, data] of Object.entries(files)) {
    const name = Buffer.from(`${folder}/${name0}`, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const n = Object.keys(files).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/* ---------- запуск из командной строки ---------- */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = assemble();
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), html, 'utf8');
  // Копия с понятным именем — её удобно отдать коллеге или положить на флешку.
  fs.writeFileSync(path.join(dist, 'Обособленный спор.html'), html, 'utf8');
  console.log(`dist/index.html — ${(Buffer.byteLength(html) / 1024).toFixed(0)} КБ`);

  const ext = extensionFiles();
  writeDir(path.join(dist, 'extension'), ext);
  const archive = zip(ext, 'kad-spor-extension');
  fs.writeFileSync(path.join(dist, 'kad-spor-extension.zip'), archive);
  console.log(`dist/extension/ и dist/kad-spor-extension.zip — ${(archive.length / 1024).toFixed(0)} КБ`);
}
