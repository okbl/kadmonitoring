/*
 * Сборка страницы в один файл: разметка, стили, шрифт и все скрипты
 * внутри dist/index.html. Один файл нужен для работы без сервера — его
 * можно открыть с диска или с флешки, и ему не нужен интернет.
 *
 * Сервер (server.mjs) отдаёт ту же сборку, собирая её на лету: правки в
 * src/ видны после обновления страницы, без отдельного шага сборки.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));

/* Порядок важен: каждый следующий модуль опирается на предыдущие. */
const SCRIPTS = [
  ['DATES', 'dates.js'],
  ['CARD', 'kad.js'],
  ['RULES', 'rules.js'],
  ['DISPUTE', 'dispute.js'],
  ['APP', 'app.js']
];

export function assemble() {
  const read = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
  let html = read('app.html');

  const fontFile = path.join(root, 'src', 'fonts', 'onest.css');
  const font = fs.existsSync(fontFile)
    ? fs.readFileSync(fontFile, 'utf8')
    : '/* Шрифт Onest не скачан (npm run font) — используется системный */';
  // Функция вместо строки замены: в коде и base64 бывают «$&» и «$1».
  html = html.replace('/* @@FONT@@ */', () => font);

  for (const [mark, file] of SCRIPTS) {
    const code = read(file).replace(/<\/script/gi, '<\\/script');
    const slot = `<!-- @@${mark}@@ -->`;
    if (!html.includes(slot)) throw new Error(`в app.html нет места для ${file}: ${slot}`);
    html = html.replace(slot, () => `<script>\n${code}\n</script>`);
  }
  return html;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = assemble();
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), html, 'utf8');
  // Копия с понятным именем — её удобно отдать коллеге или положить на флешку.
  fs.writeFileSync(path.join(dist, 'Обособленный спор.html'), html, 'utf8');
  console.log(`dist/index.html — ${(Buffer.byteLength(html) / 1024).toFixed(0)} КБ`);
}
