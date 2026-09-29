/*
 * Публикация страницы на GitHub Pages: собирает dist/index.html и кладёт
 * его в ветку gh-pages. Рабочую копию не трогает — ветка собирается во
 * временной папке через git worktree.
 *
 * На Pages — страница программы, pdf.js рядом с ней (тексты определений) и
 * архив расширения для тех, кому его можно поставить. Карточки сайт
 * загружает через вкладку kad.arbitr с закладкой «Спор ← kad», споры
 * хранит в браузере пользователя. Данных споров на сайте нет и быть не должно.
 *
 * Запуск: npm run pages [-- "сообщение коммита"]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'gh-pages';
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'inherit' });
const sha = git(['rev-parse', '--short', 'HEAD']);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kad-pages-'));

try {
  const remote = git(['ls-remote', '--heads', 'origin', BRANCH]);
  if (remote) {
    git(['fetch', 'origin', BRANCH]);
    git(['worktree', 'add', '--detach', dir, `origin/${BRANCH}`]);
    git(['checkout', '-B', BRANCH], dir);
  } else {
    git(['worktree', 'add', '--detach', dir]);
    git(['checkout', '--orphan', BRANCH], dir);
    git(['rm', '-rf', '--quiet', '.'], dir);
  }

  fs.copyFileSync(path.join(root, 'dist', 'index.html'), path.join(dir, 'index.html'));
  // pdf.js — страница загружает его, когда нужен текст определения.
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    fs.copyFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'build', f), path.join(dir, f));
  }
  fs.copyFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'LICENSE'), path.join(dir, 'LICENSE-pdfjs.txt'));
  // Архив расширения — его скачивают со страницы («Скачать расширение»).
  fs.copyFileSync(path.join(root, 'dist', 'kad-spor-extension.zip'), path.join(dir, 'kad-spor-extension.zip'));
  // Без .nojekyll Pages прогоняет файлы через Jekyll — здесь это лишнее.
  fs.writeFileSync(path.join(dir, '.nojekyll'), '');
  git(['add', '-A'], dir);

  if (!git(['status', '--porcelain'], dir)) {
    console.log('На Pages уже эта версия — публиковать нечего.');
  } else {
    const msg = process.argv[2] || `Сайт: сборка из ${sha}`;
    git(['commit', '--quiet', '-m', msg], dir);
    execFileSync('git', ['push', 'origin', `${BRANCH}:${BRANCH}`], { cwd: dir, stdio: 'inherit' });
    console.log(`Опубликовано в ветку ${BRANCH}. Если сайт ещё не включён: Settings → Pages → Deploy from a branch → ${BRANCH} / (root).`);
  }
} finally {
  try { git(['worktree', 'remove', '--force', dir]); } catch (_) { fs.rmSync(dir, { recursive: true, force: true }); }
}
