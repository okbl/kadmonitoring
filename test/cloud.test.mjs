import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIssue, siteUrl } from '../tools/cloud-check.mjs';

test('задача → спор: ссылка, дата подачи, уточнения; заглушки шаблона пропускаются', () => {
  const s = parseIssue({
    title: 'Спор: заявление от 23.06.2026, дело А60-3212/2025',
    body: 'Дата подачи: 23.06.2026\nСсылка: https://kad.arbitr.ru/Card/2aa24115-6d6f-4b9e-9c17-cd43a0bd8ef5\n' +
      'Заявитель: (необязательно)\nРоль управляющего: участник'
  });
  assert.equal(s.url, 'https://kad.arbitr.ru/Card/2aa24115-6d6f-4b9e-9c17-cd43a0bd8ef5');
  assert.equal(s.filed, '2026-06-23');
  assert.equal(s.applicant, '');
  assert.equal(s.role, 'participant');
});

test('задача без ссылки на карточку — не спор; дата берётся и из свободного текста', () => {
  assert.equal(parseIssue({ title: 'Вопрос', body: 'Как пользоваться?' }), null);
  const s = parseIssue({ title: 'Сбербанк', body: 'https://kad.arbitr.ru/Card/2aa24115-6d6f-4b9e-9c17-cd43a0bd8ef5 подано 23 июня 2026' });
  assert.equal(s.filed, '2026-06-23');
});

test('адрес сайта GitHub Pages', () => {
  assert.equal(siteUrl('okbl', 'kadmonitoring'), 'https://okbl.github.io/kadmonitoring/');
  assert.equal(siteUrl('OKBL', 'okbl.github.io'), 'https://okbl.github.io/');
});
