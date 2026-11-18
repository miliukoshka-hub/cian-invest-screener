'use strict';

const { URL, URLSearchParams } = require('node:url');

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}

function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\u00a0/g, ' ').replace(/[^\d.,-]/g, '').replace(',', '.');
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function isCianUrl(value) {
  try {
    const parsed = new URL(value);
    return /(^|\.)cian\.ru$/i.test(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function buildCianSearchUrl(params = {}) {
  if (params.customUrl && isCianUrl(params.customUrl)) return String(params.customUrl);

  const query = new URLSearchParams({
    deal_type: 'sale',
    engine_version: '2',
    offer_type: 'flat',
  });
  const regions = { moscow: 1, mo: 4593, spb: 2 };
  if (regions[params.region] !== undefined) query.set('region', String(regions[params.region]));

  if (params.propertyType === 'apartments') query.set('apartment', '1');
  if (params.propertyType === 'flat') query.set('apartment', '0');
  if (params.marketType === 'secondary') query.set('object_type[0]', '1');
  if (params.marketType === 'newbuild') query.set('object_type[0]', '2');

  const roomParams = { studio: 'room9', '1': 'room1', '2': 'room2', '3': 'room3' };
  asArray(params.rooms).forEach((room) => {
    const key = roomParams[String(room).toLowerCase()];
    if (key) query.set(key, '1');
  });

  const numericParams = [
    ['minPrice', 'minprice'], ['maxPrice', 'maxprice'],
    ['minArea', 'mintarea'], ['maxArea', 'maxtarea'],
  ];
  numericParams.forEach(([input, output]) => {
    const value = numberFrom(params[input]);
    if (value !== null && value >= 0) query.set(output, String(value));
  });

  const metroTime = numberFrom(params.maxMetroTime);
  if (metroTime !== null && metroTime >= 0) {
    query.set('foot_min', String(metroTime));
    query.set('only_foot', '2');
  }

  if (params.repairFilter === 'no_repair') query.set('repair[0]', '1');
  if (params.repairFilter === 'cosmetic') query.set('repair[0]', '2');
  if (params.repairFilter === 'euro') query.set('repair[0]', '3');
  if (params.repairFilter === 'cosmetic_euro') {
    query.set('repair[0]', '2');
    query.set('repair[1]', '3');
  }
  if (params.floorFilter === 'not_first' || params.floorFilter === 'not_first_last') query.set('is_first_floor', '0');
  if (params.sort === 'price_asc') query.set('sort', 'price_object_order');
  if (params.sort === 'sqm_asc') query.set('sort', 'price_per_meter_order');
  if (params.sort === 'creation_date') query.set('sort', 'creation_date_desc');

  return `https://www.cian.ru/cat.php?${query.toString()}`;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function textFromHtml(value) {
  return decodeHtml(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstValue(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const key of path.split('.')) {
      if (value === null || value === undefined) break;
      value = value[key];
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function unwrapNumber(value) {
  if (value && typeof value === 'object') {
    return numberFrom(firstValue(value, ['value', 'amount', 'count', 'total']));
  }
  return numberFrom(value);
}

function propertyTypeFrom(text) {
  const value = String(text || '').toLowerCase();
  if (/апарт[-\s]?отел|apart\s*hotel|сервисн\w* апарт/.test(value)) return 'apart_hotel';
  if (/апартамент|апарт|мфк|нежил\w* помещ/.test(value)) return 'apart_office';
  return 'flat';
}

function repairStateFrom(text) {
  const value = String(text || '').toLowerCase();
  if (/без отделк|без ремонта|под снос|требует ремонта|бабушкин ремонт|чернов/.test(value)) return 'no_repair';
  if (/white\s*box|вайт\s*бокс|предчист/.test(value)) return 'whitebox';
  if (/дизайнерск|евроремонт|евро-ремонт|свеж\w* ремонт|капитальн\w* ремонт/.test(value)) return 'good';
  return 'standard';
}

function marketTypeFrom(text, object) {
  const value = `${String(text || '')} ${JSON.stringify(object || {})}`.toLowerCase();
  return /новострой|новостройка|первичн|сдач[ае] дома|дду|переуступ/.test(value) ? 'newbuild' : 'secondary';
}

function normalizeListing(raw, sourceUrl, fallbackText = '') {
  const title = textFromHtml(firstValue(raw, [
    'title', 'name', 'seo.title', 'offer.title', 'description.title', 'headline',
  ]) || '');
  const rawUrl = firstValue(raw, ['url', 'link', 'fullUrl', 'seo.url', 'offer.url']);
  const url = typeof rawUrl === 'string' ? rawUrl : rawUrl && rawUrl.url;
  const idValue = firstValue(raw, ['id', 'offerId', 'itemId', 'cianId', 'offer.id']) ||
    (url && url.match(/\/(\d+)\/?(?:\?|$)/) || [])[1];

  const price = unwrapNumber(firstValue(raw, [
    'bargainTerms.price.value', 'price.value', 'priceInfo.price.value', 'offers.price',
    'offers.priceSpecification.price', 'price', 'bargainTerms.price', 'priceInfo.price',
  ]));
  const area = unwrapNumber(firstValue(raw, [
    'area', 'totalArea', 'total_area', 'floorSize.value', 'description.totalArea', 'description.area', 'roomsInfo.totalArea', 'building.area',
  ]));
  const floor = numberFrom(firstValue(raw, ['floor', 'floorNumber', 'description.floor', 'building.floor', 'building.floorNumber']));
  const floorsTotal = numberFrom(firstValue(raw, ['floorsTotal', 'floors_count', 'numberOfFloors', 'building.floorsCount', 'description.floorsTotal']));
  const pricePerSqm = unwrapNumber(firstValue(raw, ['pricePerSqm', 'price_per_meter', 'bargainTerms.pricePerMeter'])) ||
    (price && area ? Math.round(price / area) : null);
  const roomsRaw = firstValue(raw, ['rooms', 'roomsCount', 'rooms_count', 'numberOfRooms', 'roomsInfo.roomsCount', 'description.rooms']);
  let rooms = roomsRaw === undefined ? '' : String(roomsRaw);
  if (/^0$|студи/i.test(rooms)) rooms = 'Студия';
  else if (/^\d+$/.test(rooms)) rooms = `${rooms}-к`;

  const location = firstValue(raw, ['geo.address', 'address.fullName', 'address.streetAddress', 'address', 'location.address', 'geo', 'location']) || '';
  const address = typeof location === 'string' ? textFromHtml(location) : textFromHtml(firstValue(location, ['fullName', 'name', 'address', 'streetAddress']) || '');
  const metroRaw = firstValue(raw, ['metro.name', 'underground.name', 'metro', 'underground', 'geo.metro.name']) || '';
  const metro = typeof metroRaw === 'string' ? textFromHtml(metroRaw) : textFromHtml(firstValue(metroRaw, ['name', 'title']) || '');
  const metroTime = numberFrom(firstValue(raw, ['metro.time', 'metroTime', 'underground.time', 'underground.timeTo'])) ||
    numberFrom(`${JSON.stringify(raw)} ${fallbackText}`.match(/(?:метро|пешком)[^\d]{0,30}(\d+)\s*мин/i)?.[1]);
  const jkName = textFromHtml(firstValue(raw, ['jkName', 'complex.name', 'building.name', 'residentialComplex.name']) || '');
  const description = textFromHtml(firstValue(raw, ['description.text', 'description.value', 'offer.description', 'text', 'description']) || fallbackText);
  const combined = `${title} ${description} ${address} ${jkName} ${JSON.stringify(raw)}`;

  if (!idValue && !url && !price && !title) return null;
  const safeUrl = typeof url === 'string' && /^https?:\/\//i.test(url)
    ? url : (idValue ? `https://www.cian.ru/sale/flat/${idValue}/` : sourceUrl || '');
  return {
    id: String(idValue || (safeUrl.match(/\/(\d+)\/?(?:\?|$)/) || [])[1] || ''),
    title,
    url: safeUrl,
    propertyType: propertyTypeFrom(combined),
    marketType: marketTypeFrom(combined, raw),
    rooms,
    area,
    floor,
    floorsTotal,
    price,
    pricePerSqm,
    metro,
    metroTime,
    address,
    jkName,
    repairState: repairStateFrom(combined),
    description,
    activeListing: false,
  };
}

function collectJsonCandidates(value, output, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 14 || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonCandidates(item, output, seen, depth + 1));
    return;
  }
  const hasListingIdentity = ['id', 'offerId', 'url', 'fullUrl', 'bargainTerms', 'price', 'offers'].some((key) => key in value);
  const hasListingDetails = ['title', 'name', 'description', 'roomsInfo', 'totalArea', 'floorSize', 'geo', 'building', 'numberOfRooms'].some((key) => key in value);
  const likelyOffer = hasListingIdentity && hasListingDetails;
  if (likelyOffer) output.push(value);
  Object.keys(value).forEach((key) => {
    const child = value[key];
    if (typeof child === 'string' && /offersSerialized|initialState|frontend-serp/i.test(key)) {
      const parsed = parseJsonString(child);
      if (parsed) collectJsonCandidates(parsed, output, seen, depth + 1);
    } else {
      collectJsonCandidates(child, output, seen, depth + 1);
    }
  });
}

function parseJsonString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\s*<!--|-->\s*$/g, '');
  try { return JSON.parse(trimmed); } catch (_) { /* script may contain an assignment or surrounding JS */ }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch (_) { /* try arrays below */ }
  }
  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try { return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1)); } catch (_) { /* not valid JSON */ }
  }
  return null;
}

function extractJsonOffers(html) {
  const candidates = [];
  const scripts = String(html || '').match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<script\b[^>]*>|<\/script>$/gi, '').trim();
    const isRelevant = /_cianConfig|frontend-serp|initialState|offersSerialized|application\/ld\+json/i.test(script);
    if (!isRelevant) continue;
    const parsed = parseJsonString(body);
    if (parsed) collectJsonCandidates(parsed, candidates);
    const serializedMatches = body.match(/(?:offersSerialized|initialState|frontend-serp)\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi) || [];
    for (const match of serializedMatches) {
      const at = match.search(/[=:]/);
      const encoded = match.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
      try {
        const decoded = JSON.parse(`"${encoded.replace(/"/g, '\\"')}"`);
        const nested = parseJsonString(decoded);
        if (nested) collectJsonCandidates(nested, candidates);
      } catch (_) { /* ignore malformed escaped state */ }
    }
  }
  return candidates;
}

function parseCardHtml(card, sourceUrl) {
  const text = textFromHtml(card);
  const linkMatch = card.match(/href\s*=\s*["']([^"']*\/sale\/(?:flat|room|suburban)\/\d+\/?[^"']*)["']/i);
  const idMatch = card.match(/\/sale\/(?:flat|room|suburban)\/(\d+)\//i);
  const priceMatch = text.match(/([\d\s\u00a0]+)\s*(?:₽|руб(?:\.|лей)?)/i) || text.match(/(?:цена|стоимость)[^\d]{0,20}([\d\s\u00a0]+)/i);
  const areaMatch = text.match(/(\d+(?:[,.]\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i);
  const floorMatch = text.match(/(?:этаж|floor)[^\d]{0,10}(\d+)\s*(?:из|\/|этажей)[^\d]{0,5}(\d+)/i) ||
    text.match(/(\d+)\s*\/\s*(\d+)\s*этаж/);
  const roomMatch = text.match(/(студи\w*|\d+\s*[-–]?\s*(?:комн\w*|к\.?))/i);
  const metroMatch = text.match(/(?:м\.?\s*)?([А-ЯЁ][А-Яа-яЁё\s-]{2,40})\s*(?:\(|—|-)?\s*(\d{1,2})\s*мин(?:уты)?\s*(?:пешком|ходьбы)?/i);
  const titleMatch = card.match(/<(?:h[1-6]|a)[^>]*>([\s\S]*?)<\/(?:h[1-6]|a)>/i);
  const raw = {
    id: idMatch && idMatch[1],
    url: linkMatch && decodeHtml(linkMatch[1]),
    title: titleMatch ? textFromHtml(titleMatch[1]) : text.slice(0, 180),
    price: priceMatch && numberFrom(priceMatch[1]),
    area: areaMatch && numberFrom(areaMatch[1]),
    floor: floorMatch && numberFrom(floorMatch[1]),
    floorsTotal: floorMatch && numberFrom(floorMatch[2]),
    rooms: roomMatch && roomMatch[1],
    metro: metroMatch && metroMatch[1],
    metroTime: metroMatch && numberFrom(metroMatch[2]),
    description: text,
  };
  return normalizeListing(raw, sourceUrl, text);
}

function extractCardSections(html) {
  const source = String(html || '');
  const marker = /<(?:article|div)\b(?=[^>]*data-name\s*=\s*["']CardComponent["'])[^>]*>/gi;
  const starts = [];
  let found;
  while ((found = marker.exec(source))) starts.push(found.index);
  return starts.map((start, index) => {
    const end = starts[index + 1] === undefined ? Math.min(source.length, start + 18000) : starts[index + 1];
    return source.slice(start, end);
  });
}

function parseCianHtmlOrJson(html, sourceUrl = '') {
  const source = String(html || '');
  const results = [];
  const seen = new Set();
  const add = (item) => {
    if (!item) return;
    const key = item.id || item.url || `${item.title}|${item.price}|${item.area}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  extractJsonOffers(source).forEach((raw) => add(normalizeListing(raw, sourceUrl)));

  extractCardSections(source).forEach((card) => add(parseCardHtml(card, sourceUrl)));

  // Card markup is frequently nested or has changed wrappers; use sale links as a fallback.
  const linkRegex = /<a\b(?=[^>]*href\s*=\s*["'][^"']*\/sale\/(?:flat|room)\/\d+\/?)[^>]*>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(source))) {
    const id = (match[0].match(/\/sale\/(?:flat|room)\/(\d+)\//i) || [])[1];
    if (id && !seen.has(id)) {
      const cardStart = source.lastIndexOf('data-name=', match.index);
      const sectionStart = cardStart >= 0 ? source.lastIndexOf('<', cardStart) : match.index;
      const sectionEnd = source.indexOf('data-name=', match.index + match[0].length);
      const fragmentEnd = sectionEnd >= 0 ? source.lastIndexOf('<', sectionEnd) : Math.min(source.length, match.index + 18000);
      add(parseCardHtml(source.slice(Math.max(0, sectionStart), fragmentEnd > sectionStart ? fragmentEnd : match.index + match[0].length), sourceUrl));
    }
  }

  // JSON-LD may use schema.org ItemList/Offer/Apartment rather than CIAN's own state.
  const ldScripts = source.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of ldScripts) {
    const parsed = parseJsonString(script.replace(/^<script\b[^>]*>|<\/script>$/gi, ''));
    const candidates = [];
    if (parsed) collectJsonCandidates(parsed, candidates);
    candidates.forEach((raw) => add(normalizeListing(raw, sourceUrl)));
  }
  return results;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function locationRentRate(item, settings) {
  const explicit = item.propertyType === 'flat' ? settings.longRentPerSqmMonthly : settings.apartmentLongRentPerSqmMonthly;
  if (numberFrom(explicit) !== null) return Number(explicit);
  const location = `${item.address || ''} ${item.metro || ''}`.toLowerCase();
  if (/красногорск|мытищ|московск\w* обл/.test(location)) return Number(settings.moLongRentPerSqmMonthly) || 1250;
  return Number(settings.moscowLongRentPerSqmMonthly) || 1900;
}

function lowerFloorStatus(item = {}) {
  const text = `${item.title || ''} ${item.description || ''} ${item.address || ''}`.toLowerCase();
  if ((item.floor !== null && item.floor !== undefined && Number(item.floor) < 1) || /полуподвал|полуцокол|цокольн\w* этаж|подвальн\w* этаж|этаж\s*[-–]?1\b|\b-1\s*\/\s*\d+\s*этаж/i.test(text)) {
    return { type: 'basement_or_semi_basement', valueFactor: 0.70, adjustmentPct: -30, note: 'Цоколь/полуподвал: оценка цены снижена на 30%' };
  }
  if (Number(item.floor) === 1) {
    return { type: 'first_floor_check', valueFactor: 1, adjustmentPct: 0, note: 'Первый этаж: проверьте, не цоколь/полуподвал ли это' };
  }
  return { type: 'regular', valueFactor: 1, adjustmentPct: 0, note: '' };
}

function scoreLiquidity(item, discountPct) {
  const text = `${item.address || ''} ${item.metro || ''} ${item.jkName || ''}`.toLowerCase();
  const metroTime = Number(item.metroTime) || 99;
  const districtMatch = text.match(/(?:р-н|район)\s*([а-яё-]+)|([а-яё-]+(?:ский|ская|ское))\s+район/i);
  const district = districtMatch ? (districtMatch[1] || districtMatch[2]) : 'не определён';

  let transportScore = metroTime <= 5 ? 10 : metroTime <= 10 ? 9.5 : metroTime <= 15 ? 8.5 : metroTime <= 20 ? 7 : 4;
  let districtScore = /центральн|преснен|хамовник|тверск|арбат|замосквореч|басман|якиманк|дорогомил/i.test(text) ? 10 : /сокольник|даниловск|москвореч|москва/i.test(text) ? 8.5 : /красногорск|мытищ|химки|одинцов/i.test(text) ? 7 : 5;
  let floorScore = 6;
  const floor = Number(item.floor) || 0;
  const floorsTotal = Number(item.floorsTotal) || 0;
  const lowerFloor = lowerFloorStatus(item);
  if (lowerFloor.type === 'basement_or_semi_basement') floorScore = 2;
  else if (floor && floorsTotal) {
    if (floor === 1 || floor === floorsTotal) floorScore = 5;
    else if (floor >= 2 && floor <= 5) floorScore = 10;
    else if (floor < floorsTotal * 0.8) floorScore = 9.5;
    else floorScore = 7.5;
  }

  const area = Number(item.area) || 0;
  const roomsText = String(item.rooms || '').toLowerCase();
  const formatScore = area >= 20 && area <= 45 && (/студи|1-к|1-комн/.test(roomsText) || area <= 35)
    ? 10 : area >= 35 && area <= 75 ? 9 : area > 0 ? 7 : 4;
  const priceScore = discountPct >= 10 ? 10 : discountPct >= 5 ? 9.5 : discountPct >= 0 ? 8.5 : discountPct >= -5 ? 7 : 4;
  const legalScore = item.propertyType === 'flat' ? 10 : item.propertyType === 'apart_hotel' ? 7.5 : 4;
  const liquidityScore = Number((transportScore * 0.25 + districtScore * 0.20 + floorScore * 0.15 + formatScore * 0.15 + priceScore * 0.15 + legalScore * 0.10).toFixed(1));

  return { liquidityScore, transportScore, districtScore, floorScore, formatScore, legalScore, district, lowerFloor };
}

function isShareListing(item = {}) {
  const text = `${item.title || ''} ${item.rooms || ''} ${item.description || ''}`.toLowerCase();
  return /(?:^|[\s,;:])(?:доля|доли|долю|долей)\s+(?:в\s+)?(?:квартире|комнате|праве)|\d+\s*\/\s*\d+\s*дол(?:я|и|ю|ей)|долев\w*\s+собственност|часть\s+(?:квартир|комнат)/i.test(text);
}

function scoreInvestments(items = [], investorSettings = {}) {
  items = items.filter((item) => !isShareListing(item));
  const settings = investorSettings || {};
  const validSqm = items.map((item) => numberFrom(item.pricePerSqm) ||
    (numberFrom(item.price) && numberFrom(item.area) ? item.price / item.area : null)).filter((n) => n > 0);
  const avgSqmPrice = validSqm.length ? validSqm.reduce((sum, value) => sum + value, 0) / validSqm.length : 0;
  const medianSqmPrice = median(validSqm);
  const readySqm = items.filter((item) => ['standard', 'good'].includes(item.repairState))
    .map((item) => numberFrom(item.pricePerSqm) || (item.price && item.area ? item.price / item.area : 0))
    .filter((value) => value > 0);
  const flipSqmBenchmark = percentile(readySqm.length ? readySqm : validSqm, 0.75);
  const flipMode = settings.strategy === 'flip' || settings.strategy === 'flipping' || settings.flipping === true;
    const renovationRate = Number(settings.renovationCostPerSqm) || (flipMode ? 50000 : 25000);
  const dealCostRate = Number(settings.dealCostsPct) >= 0 ? Number(settings.dealCostsPct) / 100 : 0.02;
  const months = Number(settings.flipCycleMonths) > 0 ? Number(settings.flipCycleMonths) : 3;
  const occupancy = Number(settings.shortOccupancy) > 0 && Number(settings.shortOccupancy) <= 1 ? Number(settings.shortOccupancy) : 0.70;

  const scored = items.map((item) => {
    const price = Number(item.price) || 0;
    const area = Number(item.area) || 0;
    const sqmPrice = Number(item.pricePerSqm) || (price && area ? price / area : 0);
    const lowerFloor = lowerFloorStatus(item);
    const comparableMarketSqm = medianSqmPrice * lowerFloor.valueFactor;
    const discountPct = comparableMarketSqm && sqmPrice ? (comparableMarketSqm - sqmPrice) / comparableMarketSqm * 100 : 0;
    const needsRenovation = ['no_repair', 'whitebox'].includes(item.repairState);
    const estimatedRenovationCost = needsRenovation ? area * renovationRate : 0;
    const flipRepairFactor = item.repairState === 'no_repair' ? 1
      : item.repairState === 'whitebox' ? 0.65
      : item.repairState === 'standard' ? 0.40
      : 0.20;
    const flipRenovationCost = area * renovationRate * flipRepairFactor;
    const dealCosts = price * dealCostRate;
    const totalInvestment = price + dealCosts + estimatedRenovationCost;
    const isApartment = item.propertyType !== 'flat';
    const isOffice = item.propertyType === 'apart_office';
    const longRentRate = locationRentRate(item, settings);
    const estimatedLongRentMonthly = Number(item.estimatedLongRentMonthly) || (area * longRentRate);
    const estimatedShortRentDaily = Number(item.estimatedShortRentDaily) ||
      (Number(settings.shortRentDaily) || (area * (isApartment ? 105 : 95)));
    const utilitiesMonthly = Number(settings.utilitiesMonthly) || (area * (isApartment ? 190 : 150));
    const propertyTaxRate = Number(settings.propertyTaxRate) || (isOffice ? 0.02 : isApartment ? 0.005 : 0.001);
    const incomeTaxRate = Number(settings.incomeTaxRate) || (isApartment ? 0.06 : 0.04);
    const annualPropertyTax = price * propertyTaxRate;
    const annualUtilities = utilitiesMonthly * 12 * (isApartment ? 1.25 : 1);
    const longGrossAnnual = estimatedLongRentMonthly * 12;
    const longNetAnnual = longGrossAnnual * (1 - incomeTaxRate) - annualUtilities - annualPropertyTax;
    const longNetYield = totalInvestment ? longNetAnnual / totalInvestment * 100 : 0;
    const shortGrossAnnual = estimatedShortRentDaily * 365 * occupancy;
    const shortNetAnnual = shortGrossAnnual * (1 - 0.20) * (1 - incomeTaxRate) - annualUtilities - annualPropertyTax;
    const shortNetYield = totalInvestment ? shortNetAnnual / totalInvestment * 100 : 0;

    const flipEstimatedSellPrice = area && flipSqmBenchmark
      ? area * flipSqmBenchmark * (1 + (Number(settings.freshRenovationPremiumPct) || 0.05)) * lowerFloor.valueFactor : 0;
    const holdingCost = utilitiesMonthly * 1.25 * months;
    const brokerage = flipEstimatedSellPrice * (Number(settings.brokerPct) || 0.02);
    const flipTotalInvestment = price + dealCosts + flipRenovationCost;
    const taxableProfit = Math.max(0, flipEstimatedSellPrice - flipTotalInvestment - holdingCost - brokerage);
    const saleTax = taxableProfit * (Number(settings.saleTaxRate) || 0.13);
    const flipNetProfit = flipEstimatedSellPrice - flipTotalInvestment - holdingCost - brokerage - saleTax;
    const flipRoi = flipTotalInvestment ? flipNetProfit / flipTotalInvestment : 0;
    const flipCycleROI = flipRoi * 100;
    // Simple annualization avoids exponential compounding of a short estimated flip cycle.
    const flipAnnualizedROI = Math.max(-100, flipCycleROI * (12 / months));

    const requestedStrategy = settings.strategy === 'flipping' ? 'flip' : settings.strategy;
    const strategy = ['long', 'short', 'flip'].includes(requestedStrategy) ? requestedStrategy : 'auto';
    const strategyLabels = { long: 'Долгосрочная аренда', short: 'Посуточная аренда', flip: 'Флиппинг' };
    const strategyYields = [
      { key: 'long', yield: longNetYield },
      { key: 'short', yield: shortNetYield },
      { key: 'flip', yield: flipAnnualizedROI },
    ];
    const selectedStrategy = strategy === 'auto'
      ? [...strategyYields].sort((a, b) => b.yield - a.yield)[0]
      : strategyYields.find((option) => option.key === strategy);
    const bestStrategy = strategyLabels[selectedStrategy.key];
    const recommendedYield = selectedStrategy.yield;
    const liquidity = scoreLiquidity(item, discountPct);
    const scoreFinancial = (yieldValue) => Math.max(1, Math.min(10, yieldValue >= 30 ? 10 : yieldValue >= 20 ? 9.5 : yieldValue >= 12 ? 9 : yieldValue >= 8 ? 8 : yieldValue >= 5 ? 7 : 4));
    // Внутренний балл для отбора лотов остаётся widest-of-three, чтобы выбор стратегии не обнулял список.
    const bestYield = Math.max(longNetYield, shortNetYield, flipAnnualizedROI);
    const investScore = Math.max(1, Math.min(10, Math.round(liquidity.liquidityScore * 0.55 + scoreFinancial(bestYield) * 0.45)));
    const recommendationScore = liquidity.liquidityScore * 0.55 + scoreFinancial(recommendedYield) * 0.45;
    const recommendation = recommendationScore >= 7.5 ? 'strong_buy' : recommendationScore >= 5 ? 'negotiate' : 'avoid';

    return {
      ...item,
      pricePerSqm: sqmPrice || item.pricePerSqm || null,
      discountPct: Number(discountPct.toFixed(1)),
      estimatedRenovationCost: Math.round(estimatedRenovationCost),
      flipRenovationCost: Math.round(flipRenovationCost),
      dealCosts: Math.round(dealCosts),
      totalInvestment: Math.round(totalInvestment),
      flipTotalInvestment: Math.round(flipTotalInvestment),
      estimatedLongRentMonthly: Math.round(estimatedLongRentMonthly),
      estimatedShortRentDaily: Math.round(estimatedShortRentDaily),
      longNetYield: Number(longNetYield.toFixed(2)),
      shortNetYield: Number(shortNetYield.toFixed(2)),
      flipEstimatedSellPrice: Math.round(flipEstimatedSellPrice),
      flipNetProfit: Math.round(flipNetProfit),
      flipCycleROI: Number(flipCycleROI.toFixed(2)),
      flipAnnualizedROI: Number(flipAnnualizedROI.toFixed(2)),
      floorCondition: lowerFloor.type,
      fairValueAdjustmentPct: lowerFloor.adjustmentPct,
      floorConditionNote: lowerFloor.note,
      liquidityScore: liquidity.liquidityScore,
      locationScore: liquidity.districtScore,
      transportScore: liquidity.transportScore,
      floorScore: liquidity.floorScore,
      formatScore: liquidity.formatScore,
      legalScore: liquidity.legalScore,
      district: liquidity.district,
      floorCondition: liquidity.lowerFloor.type,
      floorConditionNote: liquidity.lowerFloor.note,
      fairValueAdjustmentPct: liquidity.lowerFloor.adjustmentPct,
      activeListing: Boolean(item.activeListing),
      investScore,
      recommendation,
      bestStrategy,
      recommendedYield: Number(recommendedYield.toFixed(2)),
      recommendationScore: Number(recommendationScore.toFixed(2)),
    };
  });

  Object.defineProperties(scored, {
    avgSqmPrice: { value: Math.round(avgSqmPrice), enumerable: false },
    medianSqmPrice: { value: Math.round(medianSqmPrice), enumerable: false },
  });
  return scored;
}

const SAMPLE_LISTINGS = [
  { id: 'sample-01', region: 'moscow', title: 'Студия у Павелецкой, под капитальный ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: 'Студия', area: 22.4, floor: 3, floorsTotal: 5, price: 12800000, metro: 'Павелецкая', metroTime: 9, address: 'Москва, Замоскворечье', jkName: '', repairState: 'no_repair', description: '[Расчётная оценка] Старый фонд, требуется полный ремонт.' },
  { id: 'sample-02', region: 'moscow', title: '1-к квартира у Сокольников, бабушкин ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '1-к', area: 34.2, floor: 2, floorsTotal: 9, price: 15400000, metro: 'Сокольники', metroTime: 8, address: 'Москва, Сокольники', jkName: '', repairState: 'no_repair', description: '[Расчётная оценка] Квартира под флиппинг, состояние жилое.' },
  { id: 'sample-03', region: 'moscow', title: '2-к квартира у Автозаводской, без отделки', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '2-к', area: 52.1, floor: 6, floorsTotal: 12, price: 23600000, metro: 'Автозаводская', metroTime: 7, address: 'Москва, Даниловский район', jkName: '', repairState: 'no_repair', description: '[Расчётная оценка] Нужна полная отделка.' },
  { id: 'sample-04', region: 'moscow', title: 'Студия в ЖК у ЗИЛ, white box', url: '', propertyType: 'flat', marketType: 'newbuild', rooms: 'Студия', area: 25.6, floor: 11, floorsTotal: 24, price: 16800000, metro: 'ЗИЛ', metroTime: 10, address: 'Москва, Даниловский район', jkName: 'ЗИЛАРТ', repairState: 'whitebox', description: '[Расчётная оценка] Новостройка, предчистовая отделка.' },
  { id: 'sample-05', region: 'moscow', title: '1-к квартира у Алексеевской, косметический ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '1-к', area: 39.1, floor: 7, floorsTotal: 16, price: 22400000, metro: 'Алексеевская', metroTime: 6, address: 'Москва, Алексеевский район', jkName: '', repairState: 'standard', description: '[Расчётная оценка] Аккуратное состояние, можно сдавать.' },
  { id: 'sample-06', region: 'moscow', title: '2-к квартира у Преображенской площади, под ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '2-к', area: 54.7, floor: 4, floorsTotal: 9, price: 22900000, metro: 'Преображенская площадь', metroTime: 8, address: 'Москва, Преображенское', jkName: '', repairState: 'no_repair', description: '[Расчётная оценка] Требуется обновление инженерии и отделки.' },
  { id: 'sample-07', region: 'moscow', title: 'Апартаменты-студия у Хорошёвской, готовые', url: '', propertyType: 'apart_hotel', marketType: 'newbuild', rooms: 'Студия', area: 24.8, floor: 14, floorsTotal: 30, price: 13900000, metro: 'Хорошёвская', metroTime: 5, address: 'Москва, Хорошёвский район', jkName: 'Хорошёвский', repairState: 'good', description: '[Расчётная оценка] Сервисные апартаменты с мебелью.' },
  { id: 'sample-08', region: 'moscow', title: '1-к квартира у Водного стадиона, свежий ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '1-к', area: 38.3, floor: 10, floorsTotal: 17, price: 18700000, metro: 'Водный стадион', metroTime: 7, address: 'Москва, Головинский район', jkName: '', repairState: 'good', description: '[Расчётная оценка] Готова к заселению или аренде.' },
  { id: 'sample-09', region: 'moscow', title: 'Студия у Бауманской, требует ремонта', url: '', propertyType: 'flat', marketType: 'secondary', rooms: 'Студия', area: 19.8, floor: 1, floorsTotal: 6, price: 11900000, metro: 'Бауманская', metroTime: 11, address: 'Москва, Басманный район', jkName: '', repairState: 'no_repair', description: '[Расчётная оценка] Небольшой метраж, старый ремонт.' },
  { id: 'sample-10', region: 'moscow', title: '2-к квартира у Филёвского парка, евро', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '2-к', area: 57.6, floor: 8, floorsTotal: 14, price: 26700000, metro: 'Филёвский парк', metroTime: 6, address: 'Москва, Филёвский парк', jkName: '', repairState: 'good', description: '[Расчётная оценка] Качественный ремонт, свободная продажа.' },
  { id: 'sample-11', region: 'mo', title: '1-к квартира в Красногорске, под ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '1-к', area: 36.5, floor: 5, floorsTotal: 17, price: 9800000, metro: 'Мякинино', metroTime: 18, address: 'Московская область, Красногорск', jkName: '', repairState: 'no_repair', description: '[Расчётная оценка] Вторичка в доступном бюджете.' },
  { id: 'sample-12', region: 'mo', title: 'Студия в Мытищах, white box', url: '', propertyType: 'flat', marketType: 'newbuild', rooms: 'Студия', area: 26.1, floor: 12, floorsTotal: 25, price: 8500000, metro: 'Медведково', metroTime: 25, address: 'Московская область, Мытищи', jkName: 'Новое Медведково', repairState: 'whitebox', description: '[Расчётная оценка] Новостройка с предчистовой отделкой.' },
  { id: 'sample-13', region: 'moscow', title: 'Апартаменты-студия у Павелецкой, сервисный формат', url: '', propertyType: 'apart_hotel', marketType: 'newbuild', rooms: 'Студия', area: 21.7, floor: 9, floorsTotal: 20, price: 12500000, metro: 'Павелецкая', metroTime: 8, address: 'Москва, Замоскворечье', jkName: 'Павелецкая Сити', repairState: 'good', description: '[Расчётная оценка] Апарт-отель, высокая доля краткосрочного спроса.' },
  { id: 'sample-14', region: 'moscow', title: '1-к квартира у Сокольников, готовый ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '1-к', area: 37.4, floor: 9, floorsTotal: 12, price: 20100000, metro: 'Сокольники', metroTime: 5, address: 'Москва, Сокольники', jkName: '', repairState: 'good', description: '[Расчётная оценка] Ликвидный формат рядом с парком и метро.' },
  { id: 'sample-15', region: 'moscow', title: 'Апартаменты у ЗИЛ, white box', url: '', propertyType: 'apart_office', marketType: 'newbuild', rooms: '1-к', area: 33.2, floor: 17, floorsTotal: 25, price: 15600000, metro: 'ЗИЛ', metroTime: 12, address: 'Москва, Даниловский район', jkName: 'Парк Легенд', repairState: 'whitebox', description: '[Расчётная оценка] Нежилой статус, проверяйте имущественный налог.' },
  { id: 'sample-16', region: 'moscow', title: '2-к квартира у Хорошёвской, под флиппинг', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '2-к', area: 61.3, floor: 3, floorsTotal: 17, price: 27900000, metro: 'Хорошёвская', metroTime: 9, address: 'Москва, Хорошёвский район', jkName: '', repairState: 'no_repair', description: '[Расчётная оценка] Устаревшая отделка, потенциал перепланировки требует проверки.' },
  { id: 'sample-17', region: 'moscow', title: 'Апартаменты-студия у Водного стадиона', url: '', propertyType: 'apart_hotel', marketType: 'newbuild', rooms: 'Студия', area: 23.5, floor: 6, floorsTotal: 15, price: 11200000, metro: 'Водный стадион', metroTime: 9, address: 'Москва, Головинский район', jkName: 'Водный', repairState: 'standard', description: '[Расчётная оценка] Готовые апартаменты под аренду.' },
  { id: 'sample-18', region: 'mo', title: '2-к квартира в Мытищах, евро-ремонт', url: '', propertyType: 'flat', marketType: 'secondary', rooms: '2-к', area: 56.8, floor: 8, floorsTotal: 16, price: 13700000, metro: 'Медведково', metroTime: 22, address: 'Московская область, Мытищи', jkName: '', repairState: 'good', description: '[Расчётная оценка] Готовое состояние, семейный формат.' },
];

function getLiveCachedCianListings() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const dataDir = path.resolve(__dirname, '..', 'data');
    const files = ['live-cian-cards.json', 'live-cian-flip-cards.json'];
    const merged = [];
    const seen = new Set();
    for (const file of files) {
      const fp = path.join(dataDir, file);
      if (fs.existsSync(fp)) {
        const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item && item.id && !seen.has(item.id)) {
              seen.add(item.id);
              merged.push({ ...item, region: /московская обл|мытищ|красногорск|химки|люберц|одинцов/i.test(item.address || '') ? 'mo' : 'moscow' });
            }
          }
        }
      }
    }
    return merged;
  } catch (_) {
    return [];
  }
}

function buildSafeItemCianUrl(item) {
  if (item.url && /^https:\/\/www\.cian\.ru\/sale\/flat\/\d{6,}\/?$/i.test(item.url)) {
    return item.url;
  }
  if (/^\d{6,}$/.test(String(item.id || ''))) {
    return `https://www.cian.ru/sale/flat/${item.id}/`;
  }
  const q = new URLSearchParams({
    deal_type: 'sale',
    engine_version: '2',
    offer_type: 'flat',
    region: item.region === 'mo' ? '4593' : '1',
  });
  if (item.propertyType && item.propertyType !== 'flat') q.set('apartment', '1');
  if (item.rooms === 'Студия') q.set('room9', '1');
  else if (/^1/.test(item.rooms || '')) q.set('room1', '1');
  else if (/^2/.test(item.rooms || '')) q.set('room2', '1');
  else if (/^3/.test(item.rooms || '')) q.set('room3', '1');
  if (item.price) {
    q.set('minprice', String(Math.round(item.price * 0.85)));
    q.set('maxprice', String(Math.round(item.price * 1.15)));
  }
  return `https://www.cian.ru/cat.php?${q.toString()}`;
}

function getRealisticSampleListings(params = {}) {
  const minPrice = numberFrom(params.minPrice);
  const maxPrice = numberFrom(params.maxPrice);
  const minArea = numberFrom(params.minArea);
  const maxArea = numberFrom(params.maxArea);
  const maxMetroTime = numberFrom(params.maxMetroTime);
  const wantedRooms = asArray(params.rooms).map((value) => String(value).toLowerCase()).filter((value) => value !== 'all');
  const liveCached = getLiveCachedCianListings();
  const pool = liveCached.length > 0 ? liveCached : SAMPLE_LISTINGS;

  return pool.filter((item) => {
    if (minPrice !== null && minPrice > 0 && item.price < minPrice) return false;
    if (maxPrice !== null && maxPrice > 0 && item.price > maxPrice) return false;
    if (minArea !== null && minArea > 0 && item.area < minArea) return false;
    if (maxArea !== null && maxArea > 0 && item.area > maxArea) return false;
    if (maxMetroTime !== null && maxMetroTime > 0 && item.metroTime && item.metroTime > maxMetroTime) return false;
    if (params.region === 'moscow' && item.region !== 'moscow') return false;
    if (params.region === 'mo' && item.region !== 'mo') return false;
    if (params.propertyType === 'flat' && item.propertyType !== 'flat') return false;
    if (params.propertyType === 'apartments' && item.propertyType === 'flat') return false;
    if (params.marketType && params.marketType !== 'all' && item.marketType !== params.marketType) return false;
    if (params.repairFilter === 'no_repair' && item.repairState !== 'no_repair') return false;
    if (params.repairFilter === 'cosmetic' && !['standard', 'whitebox'].includes(item.repairState)) return false;
    if (params.repairFilter === 'euro' && item.repairState !== 'good') return false;
    if (params.repairFilter === 'cosmetic_euro' && !['standard', 'good'].includes(item.repairState)) return false;
    if (wantedRooms.length && !wantedRooms.some((room) => {
      if (room === 'studio') return item.rooms === 'Студия';
      return item.rooms.toLowerCase().startsWith(room.replace(/[^\d]/g, '')) && /\d/.test(room);
    })) return false;
    return true;
  }).map((item) => ({ ...item, url: buildSafeItemCianUrl(item) }));
}

module.exports = {
  buildCianSearchUrl,
  parseCianHtmlOrJson,
  scoreInvestments,
  isShareListing,
  getRealisticSampleListings,
};
