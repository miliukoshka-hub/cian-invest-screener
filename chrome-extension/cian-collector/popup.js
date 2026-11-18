'use strict';

const statusEl = document.getElementById('status');
const button = document.getElementById('collect');

function collectVisibleCianCards() {
  const cards = [...document.querySelectorAll('[data-name="CardComponent"]')];
  const result = [];
  for (const card of cards) {
    const text = card.innerText || '';
    const anchor = card.querySelector('a[href*="/sale/flat/"]');
    if (!anchor) continue;
    const url = anchor.href.split('?')[0];
    const idMatch = url.match(/\/sale\/flat\/(\d{6,})\//);
    if (!idMatch) continue;

    const titleEl = card.querySelector('[data-mark="OfferTitle"], [data-mark="OfferSubtitle"], h3');
    const title = (titleEl?.innerText || text.split('\n')[0] || 'Объект ЦИАН').trim();
    if (/(?:^|[\s,;:])(?:доля|доли|долю|долей)\s+(?:в\s+)?(?:квартире|комнате|праве)|\d+\s*\/\s*\d+\s*дол(?:я|и|ю|ей)|долев\w*\s+собственност|часть\s+(?:квартир|комнат)/i.test(`${title} ${text}`)) continue;
    const priceText = card.querySelector('[data-mark="MainPrice"]')?.innerText ||
      (text.match(/([\d\s\u00a0]{6,})\s*(?:₽|руб(?:\.|лей)?)/i) || [])[1] || '';
    const price = Number(priceText.replace(/\D/g, '')) || 0;
    const areaMatch = (title + ' ' + text).match(/(\d+(?:[,.]\d+)?)\s*(?:м²|м2|кв\.?\s*м)/i);
    const area = areaMatch ? Number(areaMatch[1].replace(',', '.')) : 0;
    if (!price || !area) continue;

    const floorMatch = (title + ' ' + text).match(/(\d+)\s*\/\s*(\d+)\s*(?:этаж|эт)/i);
    const geo = card.querySelector('[data-name="SpecialGeo"]')?.innerText || '';
    const metroMatch = geo.match(/([^\n,•]+)[,\s]+(\d{1,2})\s*мин/i) || text.match(/([А-ЯЁ][А-Яа-яЁё\s-]{2,35})\s*(\d{1,2})\s*мин(?:ут[аы])?\s*(?:пешком)?/i);
    const address = [...card.querySelectorAll('[data-name="GeoLabel"]')].map((el) => el.innerText.trim()).filter(Boolean).join(', ');
    const lower = text.toLowerCase();
    const roomsMatch = (title + ' ' + text).match(/(студи\w*|\d+\s*[-–]?\s*(?:комнатн\w*|к\.?))/i);
    const rooms = roomsMatch ? (/студи/i.test(roomsMatch[1]) ? 'Студия' : roomsMatch[1]) : '';
    const apartment = /апартамент|апарт-отел|мфк/.test(lower);
    const serviceApartment = /апарт-отел|апарт отел|сервисн\w* апартамент/.test(lower);
    const repairState = /без отделк|без ремонта|под ремонт|чернов/.test(lower) ? 'no_repair' :
      /white\s*box|предчист/.test(lower) ? 'whitebox' :
      /евроремонт|дизайнерск|свежий ремонт/.test(lower) ? 'good' : 'standard';

    result.push({
      id: idMatch[1], title, url, propertyType: serviceApartment ? 'apart_hotel' : apartment ? 'apart_office' : 'flat',
      marketType: /первичная продажа|новострой|дду|застройщик|сдача корпуса/i.test(text) ? 'newbuild' : 'secondary',
      rooms, area, floor: floorMatch ? Number(floorMatch[1]) : null, floorsTotal: floorMatch ? Number(floorMatch[2]) : null,
      price, pricePerSqm: Math.round(price / area), metro: metroMatch ? metroMatch[1].trim() : '',
      metroTime: metroMatch ? Number(metroMatch[2]) : null, address, repairState, description: text.slice(0, 900),
      activeListing: true,
    });
  }
  return { title: document.title, url: location.href, cards: result };
}

async function readDashboardSettings() {
  const tabs = await chrome.tabs.query({ url: 'http://localhost:3456/cian-parser-dashboard.html*' });
  if (!tabs.length) return { filters: {}, investorSettings: {} };
  const injected = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: () => ({
      filters: {
        region: document.getElementById('region')?.value || 'moscow',
        propertyType: document.getElementById('propertyType')?.value || 'all',
        marketType: document.getElementById('marketType')?.value || 'all',
        rooms: [...document.querySelectorAll('input[name="rooms"]:checked')].map((el) => el.value),
        minPrice: document.getElementById('minPrice')?.value || '', maxPrice: document.getElementById('maxPrice')?.value || '',
        minArea: document.getElementById('minArea')?.value || '', maxArea: document.getElementById('maxArea')?.value || '',
        maxMetroTime: document.getElementById('maxMetroTime')?.value || '', districtFilter: document.getElementById('districtFilter')?.value || '',
        analysisStrategy: document.getElementById('analysisStrategy')?.value || 'auto',
        floorFilter: document.getElementById('floorFilter')?.value || 'all', repairFilter: document.getElementById('repairFilter')?.value || 'all',
        investorSort: document.getElementById('investorSort')?.value || 'discount_desc',
      },
      investorSettings: {
        strategy: document.getElementById('analysisStrategy')?.value || 'auto',
        renovationCostPerSqm: Number(document.getElementById('renovationRate')?.value) || 50000,
        flipCycleMonths: Number(document.getElementById('cycleMonths')?.value) || 3,
        dealCostsPct: 2, shortOccupancy: 0.7, brokerPct: 0.02, saleTaxRate: 0.13,
      },
    }),
  });
  return injected[0]?.result || { filters: {}, investorSettings: {} };
}

button.addEventListener('click', async () => {
  button.disabled = true;
  statusEl.textContent = 'Читаю карточки текущей страницы…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https:\/\/(www\.)?cian\.ru\//i.test(tab.url)) {
      throw new Error('Сначала откройте страницу результатов на cian.ru.');
    }
    const [extracted] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectVisibleCianCards });
    const snapshot = extracted?.result;
    if (!snapshot?.cards?.length) throw new Error('На этой странице не нашёл видимых карточек. Откройте выдачу, завершите проверку ЦИАН и попробуйте ещё раз.');
    const settings = await readDashboardSettings();
    statusEl.textContent = `Передаю ${snapshot.cards.length} карточек локальному скринеру…`;
    const response = await fetch('http://localhost:3456/api/browser-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: snapshot.url, items: snapshot.cards, ...settings }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось передать результаты локальному серверу.');
    statusEl.textContent = `Готово: карточек сегодня ${data.meta.scannedCount}; целый рейтинг 9–10: ${data.items.length}. Открываю скринер…`;
    await chrome.tabs.create({ url: 'http://localhost:3456/cian-parser-dashboard.html?showLatest=1' });
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
