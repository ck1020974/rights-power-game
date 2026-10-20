'use strict';
// CSV 讀寫（支援 UTF-8 BOM、引號、換行、逗號/Tab/分號分隔）。

function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQ = false;
  for (const c of first) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && c in counts) counts[c]++;
  }
  if (counts[','] >= counts['\t'] && counts[','] >= counts[';']) return ',';
  return counts['\t'] >= counts[';'] ? '\t' : ';';
}

function parseCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const delim = detectDelimiter(text);
  const rows = [];
  const lineNos = [];
  let row = [];
  let field = '';
  let inQ = false;
  let line = 1;
  let rowStart = 1;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0].trim() === '')) {
      rows.push(row);
      lineNos.push(rowStart);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"' && field === '') inQ = true;
    else if (c === delim) pushField();
    else if (c === '\r') continue;
    else if (c === '\n') {
      pushRow();
      line++;
      rowStart = line;
    } else field += c;
  }
  if (field !== '' || row.length) pushRow();
  return { rows, lineNos };
}

/**
 * 依欄位別名把表頭對應成標準欄位名。
 * aliases: { canonical: ['別名1', ...] }
 */
function toRecords(parsed, aliases) {
  if (!parsed.rows.length) return { columns: [], unknown: [], records: [] };
  const lookup = new Map();
  for (const [canon, list] of Object.entries(aliases)) {
    for (const name of [canon, ...list]) lookup.set(String(name).toLowerCase().replace(/[\s_]/g, ''), canon);
  }
  const header = parsed.rows[0].map((h) => lookup.get(h.trim().toLowerCase().replace(/[\s_]/g, '')) || null);
  const unknown = parsed.rows[0].filter((_, i) => !header[i]).map((h) => h.trim()).filter(Boolean);
  const columns = [...new Set(header.filter(Boolean))];
  const records = parsed.rows.slice(1).map((cells, i) => {
    const values = {};
    header.forEach((canon, idx) => {
      if (canon && values[canon] === undefined) values[canon] = (cells[idx] ?? '').trim();
    });
    return { line: parsed.lineNos[i + 1], values };
  });
  return { columns, unknown, records };
}

// 輸出時避免 Excel 把「=、+、-、@」開頭的文字當成公式執行
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' || typeof v === 'bigint' ? String(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells) {
  return cells.map(csvCell).join(',') + '\r\n';
}

function toCsv(headers, rows, { bom = true } = {}) {
  return (bom ? '﻿' : '') + csvLine(headers) + rows.map(csvLine).join('');
}

module.exports = { parseCsv, toRecords, csvCell, csvLine, toCsv };
