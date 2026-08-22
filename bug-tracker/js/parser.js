/**
 * parser.js — 导入解析（.xlsx/.csv）与导出（.xlsx）
 *
 * 职责：
 *  1. 解析 xlsx（SheetJS）与 csv（含编码检测 GBK/UTF-8/UTF-16）
 *  2. 表头规范化（去空格/去重），字段映射
 *  3. 生成导入预览（行数/列/样例）
 *  4. 导出当前列表 / 完整备份（多 Sheet）为 .xlsx
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.BugParser = factory(root.BugEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  /** 去掉表头首尾空格与全角空格 */
  function cleanHeader(h) {
    return String(h == null ? '' : h).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  }

  // ---------- xlsx 按需加载（v1.27.0：首屏不再加载 950KB 的 SheetJS，仅导入/导出时动态加载） ----------
  let _xlsxPromise = null;
  function ensureXlsx() {
    if (typeof XLSX !== 'undefined') return Promise.resolve();
    if (_xlsxPromise) return _xlsxPromise;
    _xlsxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('xlsx 库加载失败，请刷新重试'));
      document.head.appendChild(s);
    });
    return _xlsxPromise;
  }

  /** 解析 ArrayBuffer → 行对象数组（自动识别 xlsx/csv） */
  async function parseFile(buffer, fileName) {
    const name = String(fileName || '').toLowerCase();
    const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls');
    const isCsv = name.endsWith('.csv');

    if (!isXlsx && !isCsv) {
      return { ok: false, error: '仅支持 .xlsx / .xls / .csv 文件' };
    }

    if (isXlsx) {
      await ensureXlsx();
      return parseXlsx(buffer);
    }
    return parseCsv(buffer);
  }

  /** 解析 xlsx（SheetJS），取第一个工作表 */
  function parseXlsx(buffer) {
    try {
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const first = wb.SheetNames[0];
      if (!first) return { ok: false, error: '文件中没有工作表' };
      const ws = wb.Sheets[first];
      // header:1 → 返回二维数组（首行为表头），与 CSV 解析路径统一
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!rows.length) return { ok: false, error: '工作表为空，没有数据行' };
      return finalizeRows(rows, first);
    } catch (e) {
      console.error('[parser] xlsx 解析失败', e);
      return { ok: false, error: 'xlsx 解析失败：' + e.message };
    }
  }

  /** 解析 csv（编码自动检测） */
  function parseCsv(buffer) {
    try {
      const bytes = new Uint8Array(buffer);
      const enc = E.detectCsvEncoding(Array.from(bytes));
      let text;
      if (enc === 'utf-16le') {
        text = new TextDecoder('utf-16le').decode(bytes);
      } else if (enc === 'utf-16be') {
        text = new TextDecoder('utf-16be').decode(bytes);
      } else {
        // utf-8 / utf-8-bom：先按 UTF-8 解，若仍有乱码尝试 GBK（浏览器 TextDecoder 支持 gbk）
        let s = new TextDecoder('utf-8').decode(bytes);
        if (s.indexOf('\uFFFD') !== -1) {
          try { s = new TextDecoder('gbk').decode(bytes); } catch (e2) { /* 保持原样 */ }
        }
        text = s;
      }
      text = text.replace(/^\uFEFF/, '');
      const rows = parseCsvText(text);
      if (!rows.length) return { ok: false, error: 'CSV 为空或格式不正确' };
      return finalizeRows(rows, 'CSV');
    } catch (e) {
      console.error('[parser] csv 解析失败', e);
      return { ok: false, error: 'CSV 解析失败：' + e.message };
    }
  }

  /** CSV 文本解析（支持引号包裹、逗号/制表符分隔、换行内引号） */
  function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const len = text.length;
    let i = 0;

    // 自动判断分隔符：统计首行逗号/制表符数量
    const firstLine = text.split(/\r?\n/)[0] || '';
    const commaCount = (firstLine.match(/,/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;
    const sep = tabCount > commaCount ? '\t' : ',';

    while (i < len) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === sep) { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
        i++; continue;
      }
      field += c; i++;
    }
    // 末行
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
  }

  /** 行数组 → 对象数组（首行表头），并做列名规范化 */
  function finalizeRows(rows, sheetName) {
    const header = rows[0].map(cleanHeader);
    // 表头去重：重复列名加后缀
    const seen = {};
    const finalHeader = header.map((h) => {
      if (!h) h = '未命名列';
      if (seen[h]) { seen[h]++; return h + '(' + seen[h] + ')'; }
      seen[h] = 1;
      return h;
    });
    const data = [];
    for (let r = 1; r < rows.length; r++) {
      const obj = {};
      rows[r].forEach((cell, ci) => {
        obj[finalHeader[ci]] = String(cell == null ? '' : cell).trim();
      });
      data.push(obj);
    }
    // 预览
    const preview = data.slice(0, 5);
    const hasIdColumn = finalHeader.indexOf('编号') !== -1;
    return {
      ok: true,
      sheetName,
      columns: finalHeader,
      rows: data,
      rowCount: data.length,
      preview,
      hasIdColumn,
      missingIdWarning: !hasIdColumn ? '未找到「编号」列，无法作为主键对比，请检查表头' : ''
    };
  }

  /** 导出数据为 xlsx（多 Sheet） */
  async function exportXlsx(sheets, fileName) {
    // sheets: [{ name, rows: [对象数组] }]
    await ensureXlsx();
    const wb = XLSX.utils.book_new();
    sheets.forEach((s) => {
      const ws = XLSX.utils.json_to_sheet(s.rows);
      XLSX.utils.book_append_sheet(wb, ws, s.name);
    });
    XLSX.writeFile(wb, fileName);
  }

  /** 导出为 CSV（UTF-8 BOM，Excel 可直接打开中文） */
  function exportCsv(rows, fileName) {
    if (!rows.length) return;
    const header = Object.keys(rows[0]);
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [header.map(esc).join(',')];
    rows.forEach((r) => lines.push(header.map((h) => esc(r[h])).join(',')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return {
    parseFile, parseXlsx, parseCsv, parseCsvText, cleanHeader, finalizeRows,
    exportXlsx, exportCsv, ensureXlsx
  };
});
