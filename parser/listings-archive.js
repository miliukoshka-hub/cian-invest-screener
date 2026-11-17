'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(PROJECT_DIR, 'Архив');
const ARCHIVE_JSON = path.join(ARCHIVE_DIR, 'объекты.json');
const ARCHIVE_CSV = path.join(ARCHIVE_DIR, 'объекты.csv');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function isRealCianListing(item) {
  return item && /^\d{6,}$/.test(String(item.id || '')) &&
    /^https:\/\/www\.cian\.ru\/sale\/flat\/\d{6,}\/?$/i.test(item.url || '');
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function writeArchive(records) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const snapshot = { updatedAt: new Date().toISOString(), uniqueCount: records.length, items: records };
  fs.writeFileSync(ARCHIVE_JSON, JSON.stringify(snapshot, null, 2), 'utf8');

  const columns = [
    ['Дата первого сбора', 'firstSeenAt'], ['ID ЦИАН', 'id'], ['Объект', 'title'], ['Тип', 'propertyType'],
    ['Рынок', 'marketType'], ['Комнатность', 'rooms'], ['Площадь, м²', 'area'], ['Этаж', 'floor'],
    ['Этажей в доме', 'floorsTotal'], ['Адрес', 'address'], ['Метро', 'metro'], ['Пешком до метро, мин', 'metroTime'],
    ['Цена, ₽', 'price'], ['Цена за м², ₽', 'pricePerSqm'], ['Ремонт', 'repairState'], ['Ссылка', 'url'],
  ];
  const lines = [columns.map(([label]) => csvCell(label)).join(';')];
  for (const item of records) lines.push(columns.map(([, key]) => csvCell(item[key])).join(';'));
  fs.writeFileSync(ARCHIVE_CSV, '\uFEFF' + lines.join('\r\n'), 'utf8');
}

function seedExistingRecords() {
  const files = [
    path.join(PROJECT_DIR, 'data', 'live-cian-cards.json'),
    path.join(PROJECT_DIR, 'data', 'live-cian-flip-cards.json'),
    path.join(PROJECT_DIR, 'data', 'cian-browser-page-cache.json'),
    path.join(PROJECT_DIR, 'data', 'cian-parsed-results.json'),
  ];
  const seeded = new Map();
  for (const file of files) {
    const doc = readJson(file);
    const items = Array.isArray(doc) ? doc : Array.isArray(doc?.items) ? doc.items : [];
    for (const item of items) {
      if (!isRealCianListing(item)) continue;
      const captured = item.snapshotAt || doc?.updatedAt || item.updatedAt || new Date().toISOString();
      if (!seeded.has(String(item.id))) seeded.set(String(item.id), { ...item, firstSeenAt: captured, isNew: false });
    }
  }
  return [...seeded.values()];
}

function archiveListings(items = []) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const existing = readJson(ARCHIVE_JSON);
  const records = new Map();
  const initialItems = Array.isArray(existing?.items) ? existing.items : seedExistingRecords();
  for (const item of initialItems) {
    if (isRealCianListing(item)) records.set(String(item.id), { ...item, isNew: false });
  }

  const newIds = new Set();
  const now = new Date().toISOString();
  const current = items.filter(isRealCianListing).map((item) => {
    const key = String(item.id);
    const firstTime = !records.has(key);
    if (firstTime) {
      newIds.add(key);
      records.set(key, { ...item, firstSeenAt: now, isNew: true });
    }
    return { ...item, isNew: firstTime, firstSeenAt: records.get(key).firstSeenAt };
  });

  writeArchive([...records.values()]);
  return { items: current, newCount: newIds.size, archiveCount: records.size, archiveDir: ARCHIVE_DIR };
}

module.exports = { archiveListings, ARCHIVE_DIR, ARCHIVE_JSON, ARCHIVE_CSV };
