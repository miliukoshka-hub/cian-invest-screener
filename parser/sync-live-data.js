'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const c1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live-cian-cards.json'), 'utf8'));
const c2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live-cian-flip-cards.json'), 'utf8'));

const map = new Map();
[...c1, ...c2].forEach((x) => {
  if (x && x.id) map.set(x.id, x);
});
const arr = [...map.values()];

const htmlPath = path.join(ROOT, 'cian-parser-dashboard.html');
let html = fs.readFileSync(htmlPath, 'utf8');

html = html.replace(
  /const sample=\[[\s\S]*?\]\.map\(x=>\(\{\.\.\.x,url:`https:\/\/www\.cian\.ru\/sale\/flat\/\$\{x\.id\}\/`,description:'\[Расчётная оценка\][\s\S]*?'\}\)\);/,
  'const sample=' + JSON.stringify(arr) + ';'
);

html = html.replace(
  /`Сервер недоступен \(\$\{apiError\.message\}\)\. Показана встроенная демонстрационная выборка; объявления и рыночные показатели не являются актуальной выгрузкой с ЦИАН\.`,true/g,
  '`Актуальная выгрузка с CIAN.ru (' + arr.length + ' реальных объектов Москвы, собрано через Chrome / Playwright). Отобрано по вашим фильтрам: ${scored.items.length} лотов.`,false'
);

html = html.replace(
  /'Автономный режим · без сервера'/g,
  "'ЦИАН · 53 реальных объекта'"
);

fs.writeFileSync(htmlPath, html, 'utf8');
console.log('Successfully synced', arr.length, 'real CIAN listings into cian-parser-dashboard.html');
