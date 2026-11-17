'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const {
  buildCianSearchUrl,
  parseCianHtmlOrJson,
  scoreInvestments,
  isShareListing,
  getRealisticSampleListings,
} = require('./cian-scraper-core.js');
const { archiveListings, ARCHIVE_DIR, ARCHIVE_JSON } = require('./listings-archive.js');
const { makeExcelBuffer } = require('./excel-export.js');

const PORT = Number(process.env.PORT) || 3456;
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const REQUEST_STATE_PATH = path.join(DATA_DIR, 'cian-request-state.json');
const BROWSER_PAGE_CACHE_PATH = path.join(DATA_DIR, 'cian-browser-page-cache.json');
const EXTENSION_ORIGIN = 'chrome-extension://pipppffpliadmndnbibaldhioonogope';
const CIAN_MIN_INTERVAL_MS = Math.max(30, Number(process.env.CIAN_MIN_INTERVAL_SECONDS) || 120) * 1000;
const CIAN_FAILURE_COOLDOWN_MS = Math.max(1, Number(process.env.CIAN_FAILURE_COOLDOWN_MINUTES) || 30) * 60 * 1000;

function readCianRequestState() {
  try {
    return JSON.parse(fs.readFileSync(REQUEST_STATE_PATH, 'utf8'));
  } catch (_) {
    return { nextAllowedAt: 0, cooldownUntil: 0 };
  }
}

let cianRequestState = readCianRequestState();

function saveCianRequestState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REQUEST_STATE_PATH, JSON.stringify(cianRequestState, null, 2), 'utf8');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function fetchHtmlViaChrome(targetUrl, timeoutMs = 60000) {
  const { chromium } = require('playwright');
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: process.env.CIAN_HEADLESS === '1',
    args: ['--lang=ru-RU'],
  });
  try {
    const context = await browser.newContext({
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1800);
    let html = await page.content();
    const hasCards = await page.locator('[data-name="CardComponent"]').count().catch(() => 0);
    const challenge = /captcha|showcaptcha|подтвердите, что вы не робот|проверка безопасности/i.test(html);
    if (!hasCards && challenge && process.env.CIAN_HEADLESS !== '1') {
      console.log('ЦИАН запросил проверку в открытом Chrome. Если появится капча, пройдите её вручную — парсер подождёт до 45 секунд.');
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1500);
        if (await page.locator('[data-name="CardComponent"]').count().catch(() => 0)) break;
      }
      html = await page.content();
    }
    return { statusCode: 200, body: html, transport: 'chrome' };
  } finally {
    await browser.close().catch(() => {});
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const json = JSON.stringify(payload, null, 2);
  const origin = res.req?.headers?.origin;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  };
  if (origin === `http://localhost:${PORT}` || origin === EXTENSION_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  res.writeHead(statusCode, headers);
  res.end(json);
}

function filtersFromCianUrl(value) {
  try {
    const query = new URL(value).searchParams;
    const rooms = [];
    if (query.get('room9')) rooms.push('studio');
    if (query.get('room1')) rooms.push('1');
    if (query.get('room2')) rooms.push('2');
    if (query.get('room3')) rooms.push('3');
    const repair = query.get('repair[0]');
    const hasSecondRepair = query.has('repair[1]');
    return {
      region: query.get('region') === '4593' ? 'mo' : 'moscow',
      propertyType: query.get('apartment') === '1' ? 'apartments' : 'all',
      marketType: query.get('object_type[0]') === '1' ? 'secondary' : query.get('object_type[0]') === '2' ? 'newbuild' : 'all',
      rooms,
      minPrice: query.get('minprice') || 0,
      maxPrice: query.get('maxprice') || 0,
      minArea: query.get('mintarea') || 0,
      maxArea: query.get('maxtarea') || 0,
      maxMetroTime: query.get('foot_min') || 0,
      floorFilter: query.get('is_first_floor') === '0' ? 'not_first' : 'all',
      repairFilter: hasSecondRepair ? 'cosmetic_euro' : repair === '1' ? 'no_repair' : repair === '2' ? 'cosmetic' : repair === '3' ? 'euro' : 'all',
      investorSort: 'flip_desc',
    };
  } catch (_) {
    return { region: 'all', propertyType: 'all', marketType: 'all', rooms: [], floorFilter: 'all', repairFilter: 'all', investorSort: 'flip_desc' };
  }
}

function saveResultsToFiles(items, searchUrl, meta) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const exportedAt = new Date().toISOString();
  const exportMeta = { ...meta, lastExportAt: exportedAt };
  meta.lastExportAt = exportedAt;
  const jsonPath = path.join(DATA_DIR, 'cian-parsed-results.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        updatedAt: exportedAt,
        searchUrl,
        meta: exportMeta,
        items,
      },
      null,
      2
    ),
    'utf8'
  );

  const csvPath = path.join(DATA_DIR, 'cian-parsed-results.csv');
  const header = [
    'Название отчёта',
    'Дата последней выгрузки',
    'ID',
    'Заголовок',
    'Тип',
    'Рынок',
    'Комнат',
    'Площадь (м2)',
    'Этаж',
    'Метро',
    'Пешком (мин)',
    'Состояние ремонта',
    'Нижний этаж / цоколь',
    'Поправка справедливой цены (%)',
    'Цена (руб)',
    'Цена за м2 (руб)',
    'Дисконт к медиане (%)',
    'Оценка ремонта (руб)',
    'Полный бюджет входа (руб)',
    'Долгосрок чистая доходность (%)',
    'Посуточно чистая доходность (%)',
    'Прибыль флиппинга (руб)',
    'ROI флиппинга за цикл (%)',
    'Годовая доходность флиппинга (%)',
    'Лучшая стратегия',
    'Ссылка ЦИАН',
  ].join(';');

  const rows = items.map((it) =>
    [
      '"Подбор инвестиционных лотов"',
      `"${exportedAt}"`,
      `"${String(it.id || '').replace(/"/g, '""')}"`,
      `"${String(it.title || '').replace(/"/g, '""')}"`,
      `"${it.propertyType === 'flat' ? 'Квартира' : it.propertyType === 'apart_hotel' ? 'Апартаменты (0.5%)' : 'Апартаменты (2%)'}"`,
      `"${it.marketType === 'newbuild' ? 'Новостройка' : 'Вторичка'}"`,
      `"${it.rooms || ''}"`,
      String(it.area || 0).replace('.', ','),
      `"${it.floor || ''}/${it.floorsTotal || ''}"`,
      `"${String(it.metro || '').replace(/"/g, '""')}"`,
      it.metroTime || '',
      `"${it.repairState || ''}"`,
      `"${it.floorConditionNote || ''}"`,
      String(it.fairValueAdjustmentPct || 0).replace('.', ','),
      Math.round(it.price || 0),
      Math.round(it.pricePerSqm || 0),
      String(it.discountPct || 0).replace('.', ','),
      Math.round(it.estimatedRenovationCost || 0),
      Math.round(it.totalInvestment || 0),
      String(it.longNetYield || 0).replace('.', ','),
      String(it.shortNetYield || 0).replace('.', ','),
      Math.round(it.flipNetProfit || 0),
      String(it.flipCycleROI || 0).replace('.', ','),
      String(it.flipAnnualizedROI || 0).replace('.', ','),
      `"${it.bestStrategy || ''}"`,
      `"${it.url || ''}"`,
    ].join(';')
  );

  fs.writeFileSync(csvPath, '\uFEFF' + [header, ...rows].join('\n'), 'utf8');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin !== `http://localhost:${PORT}` && origin !== EXTENSION_ORIGIN) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  try {
    if (pathname === '/api/build-url' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const url = buildCianSearchUrl(body.filters || body);
      sendJson(res, 200, { ok: true, cianUrl: url });
      return;
    }

    if (pathname === '/api/browser-import' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let source;
      try { source = new URL(body.sourceUrl); } catch (_) { source = null; }
      if (!source || !/(^|\.)cian\.ru$/i.test(source.hostname)) {
        sendJson(res, 400, { ok: false, error: 'Источник должен быть открытой страницей cian.ru.' });
        return;
      }
      const incoming = Array.isArray(body.items) ? body.items : [];
      let validIncoming = incoming.filter((item) =>
        !isShareListing(item) && /^https:\/\/www\.cian\.ru\/sale\/flat\/\d{6,}\/?$/i.test(item.url || '') && item.price > 0 && item.area > 0
      ).map((item) => ({ ...item, activeListing: true, sourceStatus: 'visible_in_current_cian_results', snapshotAt: new Date().toISOString() }));
      const archived = archiveListings(validIncoming);
      validIncoming = archived.items;

      const search = new URL(source.toString());
      search.searchParams.delete('p');
      search.searchParams.delete('page');
      const pageKey = search.toString();
      const today = new Date().toISOString().slice(0, 10);
      let cached = { date: today, pageKey, items: [] };
      try {
        const old = JSON.parse(fs.readFileSync(BROWSER_PAGE_CACHE_PATH, 'utf8'));
        if (old.date === today && old.pageKey === pageKey && Array.isArray(old.items)) cached.items = old.items.filter((item) => !isShareListing(item));
      } catch (_) {}
      const merged = new Map(cached.items.map((item) => [String(item.id), item]));
      validIncoming.forEach((item) => merged.set(String(item.id), item));
      const rawItems = [...merged.values()];
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(BROWSER_PAGE_CACHE_PATH, JSON.stringify({ date: today, pageKey, items: rawItems }, null, 2), 'utf8');

      const filters = body.filters || {};
      const allScored = scoreInvestments(rawItems, body.investorSettings || {});
      const districtFilter = String(filters.districtFilter || '').trim().toLocaleLowerCase('ru-RU');
      const items = allScored.filter((item) => {
        if (item.activeListing !== true || item.investScore < 9.0) return false;
        if (districtFilter && !`${item.address || ''} ${item.metro || ''} ${item.district || ''}`.toLocaleLowerCase('ru-RU').includes(districtFilter)) return false;
        if (filters.floorFilter === 'not_first' && (!item.floor || item.floor === 1)) return false;
        if (filters.floorFilter === 'not_first_last' && (!item.floor || item.floor === 1 || (item.floorsTotal && item.floor === item.floorsTotal))) return false;
        return true;
      });
      const sortMode = filters.investorSort || 'discount_desc';
      items.sort((a, b) => {
        const primary = sortMode === 'rent_desc'
          ? Math.max(b.longNetYield, b.shortNetYield) - Math.max(a.longNetYield, a.shortNetYield)
          : sortMode === 'flip_desc' ? b.flipAnnualizedROI - a.flipAnnualizedROI
          : sortMode === 'sqm_asc' ? a.pricePerSqm - b.pricePerSqm
          : (b.discountPct || 0) - (a.discountPct || 0);
        return primary || b.investScore - a.investScore;
      });
      const meta = {
        totalCount: items.length,
        scannedCount: rawItems.length,
        avgSqmPrice: allScored.avgSqmPrice || 0,
        medianSqmPrice: allScored.medianSqmPrice || 0,
        sourceType: 'browser_visible_cian',
        snapshotAt: new Date().toISOString(),
        flipCycleMonths: Number(body.investorSettings?.flipCycleMonths) || 3,
        renovationCostPerSqm: Number(body.investorSettings?.renovationCostPerSqm) || 50000,
        filters,
        investorSettings: body.investorSettings || {},
        newlySeenCount: archived.newCount,
        note: `Просмотрено карточек: ${rawItems.length}; новых для архива: ${archived.newCount}. Объекты отсортированы от наиболее привлекательных к менее привлекательным. Новые отмечены значком 🆕.`
      };
      saveResultsToFiles(items, pageKey, meta);
      sendJson(res, 200, { ok: true, meta, items });
      return;
    }

    if (pathname === '/api/export-xlsx' && req.method === 'GET') {
      const latestPath = path.join(DATA_DIR, 'cian-parsed-results.json');
      if (!fs.existsSync(latestPath)) {
        sendJson(res, 404, { ok: false, error: 'Сначала соберите объекты со страницы ЦИАН.' });
        return;
      }
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      const items = Array.isArray(latest.items) ? latest.items : [];
      if (!items.length) {
        sendJson(res, 404, { ok: false, error: 'В последней выгрузке нет объектов для файла Excel.' });
        return;
      }
      const exportDate = latest.meta?.lastExportAt || latest.updatedAt || new Date().toISOString();
      const buffer = makeExcelBuffer(items, exportDate);
      const fileName = `podbor-investicionnyh-lotov-${String(exportDate).slice(0, 10)}.xlsx`;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, fileName), buffer);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': buffer.length,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
      return;
    }

    if (pathname === '/api/archive-xlsx' && req.method === 'GET') {
      let archive = { items: [] };
      try { archive = JSON.parse(fs.readFileSync(ARCHIVE_JSON, 'utf8')); } catch (_) {}
      if (!Array.isArray(archive.items) || !archive.items.length) {
        sendJson(res, 404, { ok: false, error: 'Архив пока пуст. Соберите текущую страницу ЦИАН.' });
        return;
      }
      const buffer = makeExcelBuffer(archive.items, archive.updatedAt || new Date());
      const fileName = `arhiv-obektov-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': buffer.length,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
      return;
    }

    if (pathname === '/api/recalculate-latest' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const filters = body.filters || {};
      const investorSettings = { ...(body.investorSettings || {}), strategy: 'flip' };
      const cache = JSON.parse(fs.readFileSync(BROWSER_PAGE_CACHE_PATH, 'utf8'));
      const allScored = scoreInvestments(cache.items || [], investorSettings);
      const rooms = Array.isArray(filters.rooms) ? filters.rooms.map(String) : [];
      const minPrice = Number(filters.minPrice) || 0;
      const maxPrice = Number(filters.maxPrice) || 0;
      const minArea = Number(filters.minArea) || 0;
      const maxArea = Number(filters.maxArea) || 0;
      const district = String(filters.districtFilter || '').trim().toLocaleLowerCase('ru-RU');
      const matchesRoom = (item) => !rooms.length || rooms.some((room) => room === 'studio'
        ? item.rooms === 'Студия'
        : String(item.rooms || '').replace(/[^\d]/g, '').startsWith(room));
      const items = allScored.filter((item) => {
        const address = `${item.address || ''} ${item.metro || ''}`.toLocaleLowerCase('ru-RU');
        const isMo = /московская обл|красногорск|мытищ|химки|балаших|люберц|одинцов/i.test(address);
        if (!item.activeListing || item.investScore < 9) return false;
        if (filters.region === 'moscow' && isMo || filters.region === 'mo' && !isMo) return false;
        if (filters.propertyType === 'flat' && item.propertyType !== 'flat') return false;
        if (filters.propertyType === 'apartments' && item.propertyType === 'flat') return false;
        if (filters.marketType && filters.marketType !== 'all' && item.marketType !== filters.marketType) return false;
        if (!matchesRoom(item)) return false;
        if (minPrice && item.price < minPrice || maxPrice && item.price > maxPrice) return false;
        if (minArea && item.area < minArea || maxArea && item.area > maxArea) return false;
        if (Number(filters.maxMetroTime) > 0 && Number(item.metroTime) > Number(filters.maxMetroTime)) return false;
        if (district && !address.includes(district)) return false;
        if (filters.floorFilter === 'not_first' && (!item.floor || item.floor === 1)) return false;
        if (filters.floorFilter === 'not_first_last' && (!item.floor || item.floor === 1 || item.floor === item.floorsTotal)) return false;
        if (filters.repairFilter === 'no_repair' && item.repairState !== 'no_repair') return false;
        if (filters.repairFilter === 'cosmetic_euro' && !['standard', 'good'].includes(item.repairState)) return false;
        if (filters.repairFilter === 'cosmetic' && !['standard', 'whitebox'].includes(item.repairState)) return false;
        if (filters.repairFilter === 'euro' && item.repairState !== 'good') return false;
        return true;
      });
      const sortMode = filters.investorSort || 'flip_desc';
      items.sort((a, b) => {
        const primary = sortMode === 'rent_desc'
          ? Math.max(b.longNetYield, b.shortNetYield) - Math.max(a.longNetYield, a.shortNetYield)
          : sortMode === 'sqm_asc' ? a.pricePerSqm - b.pricePerSqm
          : sortMode === 'discount_desc' ? b.discountPct - a.discountPct
          : b.flipAnnualizedROI - a.flipAnnualizedROI;
        return primary || b.investScore - a.investScore;
      });
      const meta = {
        sourceType: 'browser_visible_cian',
        scannedCount: (cache.items || []).length,
        totalCount: items.length,
        avgSqmPrice: allScored.avgSqmPrice || 0,
        medianSqmPrice: allScored.medianSqmPrice || 0,
        snapshotAt: new Date().toISOString(),
        flipCycleMonths: Number(investorSettings.flipCycleMonths) || 3,
        renovationCostPerSqm: Number(investorSettings.renovationCostPerSqm) || 50000,
        note: `Пересчитано объектов: ${items.length}. Для флиппинга учтён ремонт с поправкой на состояние объекта; годовой ROI — без реинвестирования.`,
      };
      saveResultsToFiles(items, cache.pageKey || 'Пересчёт текущего снимка ЦИАН', meta);
      sendJson(res, 200, { ok: true, meta, items });
      return;
    }

    if (pathname === '/api/latest-results' && req.method === 'GET') {
      const latestPath = path.join(DATA_DIR, 'cian-parsed-results.json');
      if (!fs.existsSync(latestPath)) {
        sendJson(res, 200, { ok: true, meta: { totalCount: 0, sourceType: 'empty' }, items: [] });
        return;
      }
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      const meta = { ...(latest.meta || {}), lastExportAt: latest.updatedAt || latest.meta?.lastExportAt || null };
      let items = latest.items || [];
      if (meta.sourceType === 'browser_visible_cian' && fs.existsSync(BROWSER_PAGE_CACHE_PATH)) {
        try {
          const cache = JSON.parse(fs.readFileSync(BROWSER_PAGE_CACHE_PATH, 'utf8'));
          if (Array.isArray(cache.items) && (!latest.searchUrl || cache.pageKey === latest.searchUrl)) {
            const filters = meta.filters || filtersFromCianUrl(cache.pageKey || latest.searchUrl || '');
            const investorSettings = { ...(meta.investorSettings || {}), strategy: 'flip', renovationCostPerSqm: Number(meta.renovationCostPerSqm) || 50000, flipCycleMonths: Number(meta.flipCycleMonths) || 3 };
            const allScored = scoreInvestments(cache.items, investorSettings);
            const rooms = Array.isArray(filters.rooms) ? filters.rooms.map(String) : [];
            const minPrice = Number(filters.minPrice) || 0;
            const maxPrice = Number(filters.maxPrice) || 0;
            const minArea = Number(filters.minArea) || 0;
            const maxArea = Number(filters.maxArea) || 0;
            const district = String(filters.districtFilter || '').trim().toLocaleLowerCase('ru-RU');
            const itemsById = new Map(allScored.filter((item) => {
              const address = `${item.address || ''} ${item.metro || ''}`.toLocaleLowerCase('ru-RU');
              const isMo = /московская обл|красногорск|мытищ|химки|балаших|люберц|одинцов/i.test(address);
              const roomMatch = !rooms.length || rooms.some((room) => room === 'studio' ? item.rooms === 'Студия' : String(item.rooms || '').replace(/[^\d]/g, '').startsWith(room));
              if (!item.activeListing || item.investScore < 9) return false;
              if (filters.region === 'moscow' && isMo || filters.region === 'mo' && !isMo) return false;
              if (filters.propertyType === 'flat' && item.propertyType !== 'flat') return false;
              if (filters.propertyType === 'apartments' && item.propertyType === 'flat') return false;
              if (filters.marketType && filters.marketType !== 'all' && item.marketType !== filters.marketType) return false;
              if (!roomMatch || minPrice && item.price < minPrice || maxPrice && item.price > maxPrice || minArea && item.area < minArea || maxArea && item.area > maxArea) return false;
              if (Number(filters.maxMetroTime) > 0 && Number(item.metroTime) > Number(filters.maxMetroTime)) return false;
              if (district && !address.includes(district)) return false;
              if (filters.floorFilter === 'not_first' && (!item.floor || item.floor === 1)) return false;
              if (filters.floorFilter === 'not_first_last' && (!item.floor || item.floor === 1 || item.floor === item.floorsTotal)) return false;
              if (filters.repairFilter === 'no_repair' && item.repairState !== 'no_repair') return false;
              if (filters.repairFilter === 'cosmetic_euro' && !['standard', 'good'].includes(item.repairState)) return false;
              if (filters.repairFilter === 'cosmetic' && !['whitebox', 'standard'].includes(item.repairState)) return false;
              if (filters.repairFilter === 'euro' && item.repairState !== 'good') return false;
              return true;
            }).map((item) => [String(item.id), item]));
            items = [...itemsById.values()];
            const sortMode = filters.investorSort || 'flip_desc';
            items.sort((a, b) => {
              const primary = sortMode === 'rent_desc' ? Math.max(b.longNetYield, b.shortNetYield) - Math.max(a.longNetYield, a.shortNetYield)
                : sortMode === 'sqm_asc' ? a.pricePerSqm - b.pricePerSqm
                : sortMode === 'discount_desc' ? b.discountPct - a.discountPct
                : b.flipAnnualizedROI - a.flipAnnualizedROI;
              return primary || b.investScore - a.investScore;
            });
            Object.assign(meta, { filters, investorSettings, scannedCount: cache.items.length, totalCount: items.length, avgSqmPrice: allScored.avgSqmPrice || 0, medianSqmPrice: allScored.medianSqmPrice || 0, flipCycleMonths: investorSettings.flipCycleMonths, renovationCostPerSqm: investorSettings.renovationCostPerSqm, note: `Автоматически пересчитано по сохранённому снимку: ${cache.items.length} карточек. Для флиппинга учтён ремонт с поправкой на состояние; годовой результат пересчитан без реинвестирования.` });
            fs.writeFileSync(latestPath, JSON.stringify({ ...latest, meta, items }, null, 2), 'utf8');
          }
        } catch (_) {}
      }
      const cycleMonths = Number(meta.flipCycleMonths) || 3;
      const refreshedItems = items.map((item) => {
        const totalInvestment = Number(item.flipTotalInvestment) || Number(item.totalInvestment) || 0;
        const cycleROI = totalInvestment ? (Number(item.flipNetProfit) || 0) / totalInvestment * 100 : 0;
        return { ...item, flipCycleROI: Number(cycleROI.toFixed(2)), flipAnnualizedROI: Number((cycleROI * 12 / cycleMonths).toFixed(2)) };
      });
      sendJson(res, 200, { ok: true, meta, items: refreshedItems });
      return;
    }

    if (pathname === '/api/export-xlsx' && req.method === 'GET') {
      const latestPath = path.join(DATA_DIR, 'cian-parsed-results.json');
      if (!fs.existsSync(latestPath)) {
        sendJson(res, 404, { ok: false, error: 'Сначала соберите объекты с текущей страницы ЦИАН.' });
        return;
      }
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      const items = Array.isArray(latest.items) ? latest.items : [];
      if (!items.length) {
        sendJson(res, 404, { ok: false, error: 'В последней выгрузке нет объектов для экспорта.' });
        return;
      }
      const exportedAt = latest.meta?.lastExportAt || latest.updatedAt || new Date().toISOString();
      const buffer = makeExcelBuffer(items, exportedAt);
      const datePart = String(exportedAt).slice(0, 10);
      const fileName = `podbor-investicionnyh-lotov-${datePart}.xlsx`;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, fileName), buffer);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': buffer.length,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
      return;
    }

    if (pathname === '/api/archive-xlsx' && req.method === 'GET') {
      const archive = fs.existsSync(ARCHIVE_JSON) ? JSON.parse(fs.readFileSync(ARCHIVE_JSON, 'utf8')) : { items: [] };
      const items = Array.isArray(archive.items) ? archive.items : [];
      if (!items.length) {
        sendJson(res, 404, { ok: false, error: 'Архив пока пуст.' });
        return;
      }
      const buffer = makeExcelBuffer(items, archive.updatedAt || new Date());
      const fileName = `arhiv-obektov-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': buffer.length,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
      return;
    }

    if (pathname === '/api/search' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const filters = body.filters || {};
      const investorSettings = body.investorSettings || {};
      const mode = body.mode || 'auto'; // 'auto' | 'live' | 'html' | 'sample'
      const searchUrl = buildCianSearchUrl(filters);

      let rawListings = [];
      let sourceType = 'unverified';
      let note = '';
      let chromeIssue = '';

      if (mode === 'html' && body.rawHtml) {
        rawListings = parseCianHtmlOrJson(body.rawHtml, searchUrl);
        if (body.snapshotConfirmed === true) {
          rawListings = rawListings
            .filter((item) => !isShareListing(item) && /^https:\/\/www\.cian\.ru\/sale\/flat\/\d{6,}\/?$/i.test(item.url || '') && item.price > 0 && item.area > 0)
            .map((item) => ({ ...item, activeListing: true }));
          sourceType = 'live_cian_snapshot';
          note = `Извлечено ${rawListings.length} карточек из только что сохранённой страницы текущей выдачи ЦИАН. Проверьте, что HTML сохранён после открытия свежего поиска.`;
        } else {
          sourceType = 'unverified_html';
          note = 'Импорт не подтверждён как свежая выдача ЦИАН; результаты скрыты, чтобы не показывать снятые объявления.';
          rawListings = [];
        }
      } else if (mode === 'live' || mode === 'auto') {
        const now = Date.now();
        const nextAllowedAt = Math.max(cianRequestState.nextAllowedAt || 0, cianRequestState.cooldownUntil || 0);
        if (now < nextAllowedAt) {
          sourceType = 'request_cooldown';
          const seconds = Math.ceil((nextAllowedAt - now) / 1000);
          note = `Запросы намеренно выполняются реже: повторите поиск через ${seconds} секунд. После тайм-аута или проверки ЦИАН действует увеличенная пауза.`;
        } else {
          cianRequestState.nextAllowedAt = now + CIAN_MIN_INTERVAL_MS;
          saveCianRequestState();
          try {
            const response = await fetchHtmlViaChrome(searchUrl, 60000);
            const isCaptcha =
              response.statusCode === 403 ||
              response.statusCode === 429 ||
              /captcha|showcaptcha|робот|подтвердите/i.test(response.body);
            if (!isCaptcha) {
              rawListings = parseCianHtmlOrJson(response.body, searchUrl);
            }
            if (rawListings.length > 0) {
              rawListings = rawListings
                .filter((item) => !isShareListing(item) && /^https:\/\/www\.cian\.ru\/sale\/flat\/\d{6,}\/?$/i.test(item.url || '') && item.price > 0 && item.area > 0)
                .map((item) => ({ ...item, activeListing: true }));
              sourceType = 'live_cian';
              cianRequestState.cooldownUntil = 0;
              note = `Текущая выдача cian.ru через Chrome (${rawListings.length} активных карточек до инвест-фильтра).`;
            } else {
              sourceType = 'no_live_data';
              cianRequestState.cooldownUntil = Date.now() + CIAN_FAILURE_COOLDOWN_MS;
              note = isCaptcha
                ? `ЦИАН показал проверку. Новый автоматический запрос будет не раньше чем через ${Math.round(CIAN_FAILURE_COOLDOWN_MS / 60000)} мин.; пройдите её в обычном браузере и импортируйте свежую HTML-выдачу.`
                : `В текущей выдаче не обнаружены карточки. Следующая попытка — через ${Math.round(CIAN_FAILURE_COOLDOWN_MS / 60000)} мин.; устаревшие объявления не показываются.`;
            }
          } catch (err) {
            sourceType = 'no_live_data';
            cianRequestState.cooldownUntil = Date.now() + CIAN_FAILURE_COOLDOWN_MS;
            chromeIssue = err.message;
            note = `Запрос к ЦИАН завершился тайм-аутом (${chromeIssue}). Повторный запрос отложен на ${Math.round(CIAN_FAILURE_COOLDOWN_MS / 60000)} мин., чтобы не перегружать сайт. Проверьте доступ к cian.ru в обычном браузере; пока можно загрузить свежую HTML-выдачу.`;
          }
          saveCianRequestState();
        }
      } else {
        sourceType = 'no_live_data';
        note = 'Демо-данные отключены: показываются только объявления из текущей живой выдачи ЦИАН.';
      }

      const allScored = scoreInvestments(rawListings, investorSettings);
      const districtFilter = String(filters.districtFilter || '').trim().toLocaleLowerCase('ru-RU');
      const scored = allScored.filter((item) => {
        if (item.activeListing !== true || item.investScore < 9.0) return false;
        if (districtFilter && !`${item.address || ''} ${item.metro || ''} ${item.district || ''}`.toLocaleLowerCase('ru-RU').includes(districtFilter)) return false;
        if (filters.floorFilter === 'not_first' && (!item.floor || item.floor === 1)) return false;
        if (filters.floorFilter === 'not_first_last' && (!item.floor || item.floor === 1 || (item.floorsTotal && item.floor === item.floorsTotal))) return false;
        return true;
      });

      // Сортировка результатов для инвестора
      const sortMode = filters.investorSort || 'discount_desc';
      scored.sort((a, b) => {
        const primary = sortMode === 'rent_desc'
          ? Math.max(b.longNetYield, b.shortNetYield) - Math.max(a.longNetYield, a.shortNetYield)
          : sortMode === 'flip_desc' ? (b.flipAnnualizedROI || 0) - (a.flipAnnualizedROI || 0)
          : sortMode === 'sqm_asc' ? (a.pricePerSqm || 0) - (b.pricePerSqm || 0)
          : (b.discountPct || 0) - (a.discountPct || 0);
        return primary || b.investScore - a.investScore;
      });

      const meta = {
        totalCount: scored.length,
        avgSqmPrice: allScored.avgSqmPrice || 0,
        medianSqmPrice: allScored.medianSqmPrice || 0,
        sourceType,
        note,
      };

      saveResultsToFiles(scored, searchUrl, meta);

      sendJson(res, 200, {
        ok: true,
        searchUrl,
        meta,
        items: scored,
      });
      return;
    }

    // Статические файлы (HTML, CSV, JSON)
    let relPath = pathname === '/' ? '/cian-parser-dashboard.html' : pathname;
    const safePath = path.normalize(path.join(ROOT_DIR, relPath));
    if (!safePath.startsWith(ROOT_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-store, no-cache, must-revalidate' : 'no-cache',
      });
      fs.createReadStream(safePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Файл не найден: ' + pathname);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('==========================================================');
  console.log(' Инвестиционный парсер ЦИАН и калькулятор запущен!');
  console.log(` Откройте в браузере: http://localhost:${PORT}`);
  console.log('==========================================================');
});
