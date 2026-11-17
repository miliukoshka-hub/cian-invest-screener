'use strict';

const { zipSync, strToU8 } = require('fflate');

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function columnName(index) {
  let name = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function cellXml(value, ref, header = false) {
  const style = header ? ' s="1"' : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function makeExcelBuffer(items, exportedAt = new Date()) {
  const date = exportedAt instanceof Date ? exportedAt : new Date(exportedAt);
  const dateLabel = Number.isNaN(date.getTime()) ? new Date().toLocaleString('ru-RU') : date.toLocaleString('ru-RU');
  const columns = [
    ['Дата последней выгрузки', () => dateLabel], ['Новое в этой выгрузке', (x) => x.isNew ? 'Да 🆕' : 'Нет'],
    ['Первое появление в архиве', (x) => x.firstSeenAt ? new Date(x.firstSeenAt).toLocaleString('ru-RU') : ''],
    ['ID ЦИАН', (x) => String(x.id || '')], ['Объект', (x) => x.title || ''],
    ['Тип', (x) => x.propertyType === 'flat' ? 'Квартира' : x.propertyType === 'apart_hotel' ? 'Апартаменты, гостиничный тип' : 'Апартаменты, нежилое помещение'],
    ['Рынок', (x) => x.marketType === 'newbuild' ? 'Новостройка' : 'Вторичный рынок'], ['Комнатность', (x) => x.rooms || ''],
    ['Площадь, м²', (x) => Number(x.area) || 0], ['Этаж', (x) => x.floor ? `${x.floor}/${x.floorsTotal || '?'}` : 'Не указан'],
    ['Адрес', (x) => x.address || ''], ['Метро', (x) => x.metro || ''], ['Пешком до метро, мин', (x) => Number(x.metroTime) || 0],
    ['Состояние ремонта', (x) => x.repairState || ''], ['Проверка первого этажа', (x) => x.floorConditionNote || ''],
    ['Поправка стоимости, %', (x) => Number(x.fairValueAdjustmentPct) || 0], ['Цена, ₽', (x) => Number(x.price) || 0],
    ['Цена за м², ₽', (x) => Number(x.pricePerSqm) || 0], ['Отклонение от аналогов, %', (x) => Number(x.discountPct) || 0],
    ['Ремонт для аренды, ₽', (x) => Number(x.estimatedRenovationCost) || 0], ['Ремонт для флиппинга, ₽', (x) => Number(x.flipRenovationCost) || 0], ['Сделка, ₽', (x) => Number(x.dealCosts) || 0],
    ['Всего вложений, ₽', (x) => Number(x.totalInvestment) || 0], ['Чистая доходность долгосрочной аренды, % годовых', (x) => Number(x.longNetYield) || 0],
    ['Чистая доходность посуточной аренды, % годовых', (x) => Number(x.shortNetYield) || 0], ['Прибыль флиппинга, ₽', (x) => Number(x.flipNetProfit) || 0],
    ['Доходность флиппинга за цикл, %', (x) => Number(x.flipCycleROI) || 0], ['Доходность флиппинга, % годовых без реинвестирования', (x) => Number(x.flipAnnualizedROI) || 0],
    ['Стратегия', (x) => x.bestStrategy || ''], ['Ссылка на объявление', (x) => x.url || ''],
  ];
  const rows = [columns.map(([header]) => header), ...items.map((item) => columns.map(([, getValue]) => getValue(item)))];
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, index) => cellXml(value, `${columnName(index + 1)}${rowIndex + 1}`, rowIndex === 0)).join('')}</row>`).join('');
  const widths = [22, 19, 22, 16, 44, 28, 18, 14, 13, 12, 48, 24, 20, 18, 48, 18, 18, 20, 22, 18, 18, 20, 34, 34, 20, 18, 32, 24, 62];
  const colsXml = `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`;
  const endCell = `${columnName(columns.length)}${rows.length}`;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${colsXml}<sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${endCell}"/></worksheet>`;
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Подбор объектов" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(worksheet),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

module.exports = { makeExcelBuffer };
