/** storage/parser 模块测试（Node 环境，模拟 localStorage） */
const assert = require('assert');
global.localStorage = (() => {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
})();
const E = require('../js/engine.js');
const Storage = require('../js/storage.js');
const Parser = require('../js/parser.js');

let passed = 0, failed = 0, pending = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending++;
      r.then(() => { passed++; console.log('  ✅ ' + name); finish(); })
        .catch((e) => { failed++; console.log('  ❌ ' + name + '\n     ' + e.message); finish(); });
      return;
    }
    passed++; console.log('  ✅ ' + name);
  } catch (e) { failed++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}
function finish() {
  if (--pending === 0) {
    console.log(`\n结果：${passed} 通过, ${failed} 失败\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

function row(id, overrides) {
  const r = { '编号': id, '标题': 't', '描述': '', '状态': '新建', '发现发布': 'V1.0', '分析原因': '', '停留天数': '0', '严重程度': '一般', '当前责任人': '张三', '最近修改时间': '', '创建人': '', '退回原因': '', '激活原因': '', '最近更新人': '' };
  Object.assign(r, overrides || {}); return r;
}

console.log('\n=== storage/parser 单元测试 ===\n');

test('save/load 往返一致', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  assert.strictEqual(Storage.saveState(s).ok, true);
  const loaded = Storage.loadState('1.0.0');
  assert.ok(loaded.bugs['B1']);
  assert.strictEqual(loaded.bugs['B1'].fields['编号'], 'B1');
});

test('损坏数据回退空状态', () => {
  localStorage.setItem(Storage.STATE_KEY, '{bad json');
  const s = Storage.loadState('1.0.0');
  assert.deepStrictEqual(s.bugs, {});
});

test('buildBackup 包含系统字段与 4 个数据集', () => {
  const s = E.emptyState('1.0.0');
  s.people = ['张三', '李四'];
  E.applyImport(s, [row('B1', { '当前责任人': '张三' })], '2026-08-12T09:00:00');
  E.reassign(s, 'B1', '李四', '2026-08-12T10:00:00', s.people);
  const b = Storage.buildBackup(s);
  assert.ok(b.__backupMeta);
  assert.strictEqual(b.bugs.length, 1);
  assert.strictEqual(b.bugs[0]['__首次发现日'], '2026-08-12T09:00:00');
  assert.strictEqual(b.bugs[0]['__上次责任人'], '张三');
  assert.strictEqual(b.history.length, 1);
  assert.strictEqual(b.people.length, 2);
  assert.strictEqual(b.snapshots.length, 1);
});

test('restoreBackup 完整还原（含系统字段/历史/人员/快照）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '张三' })], '2026-08-12T09:00:00');
  E.applyImport(s, [row('B1'), row('B2', { '当前责任人': '王五' })], '2026-08-13T09:00:00');
  const backup = Storage.buildBackup(s);
  const restored = Storage.restoreBackup(E.emptyState('1.0.0'), backup);
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.summary.bugs, 2);
  assert.strictEqual(restored.summary.snapshots, 2);
  const b1 = restored.state.bugs['B1'];
  assert.strictEqual(b1.sys.firstSeenAt, '2026-08-12T09:00:00');
  assert.strictEqual(b1.sys.lastImportedAt, '2026-08-13T09:00:00');
});

test('restoreBackup 缺 bugs 拒绝', () => {
  const r = Storage.restoreBackup(E.emptyState('1.0.0'), { history: [] });
  assert.strictEqual(r.ok, false);
});

// ---- parser ----
test('parseCsvText 基础解析', () => {
  const rows = Parser.parseCsvText('编号,标题\nB1,测试标题\nB2,"含,逗号"\nB3,"含\n换行"');
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0][0], '编号');
  assert.strictEqual(rows[2][1], '含,逗号');
  assert.strictEqual(rows[3][1], '含\n换行');
});

test('parseCsvText 制表符分隔', () => {
  const rows = Parser.parseCsvText('编号\t标题\nB1\t标题1');
  assert.strictEqual(rows[1][0], 'B1');
  assert.strictEqual(rows[1][1], '标题1');
});

test('finalizeRows 列名清理与编号检测', () => {
  const res = Parser.parseCsvText(' 编号 ,标题\nB1,标题1');
  const rows = Parser.finalizeRows(res, 'CSV');
  assert.strictEqual(rows.columns[0], '编号');
  assert.strictEqual(rows.hasIdColumn, true);
  assert.strictEqual(rows.rowCount, 1);
  assert.strictEqual(rows.rows[0]['标题'], '标题1');
});

test('cleanHeader 去全角空格', () => {
  assert.strictEqual(Parser.cleanHeader('　编号　'), '编号');
});

// ===== xlsx 解析集成测试（真实文件） =====
const fs = require('fs');
const path = require('path');
global.XLSX = require('../vendor/xlsx.full.min.js');
XLSX.set_fs(require('fs'));

test('xlsx 真实文件解析 → 引擎导入链路', async () => {
  const xlsxPath = path.join(__dirname, '..', 'sample-示例BUG列表.xlsx');
  const buf = fs.readFileSync(xlsxPath);
  const bufArr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const res = await Parser.parseFile(bufArr, 'sample-示例BUG列表.xlsx');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.rowCount, 4);
  assert.strictEqual(res.hasIdColumn, true);
  assert.strictEqual(res.columns.indexOf('严重程度') !== -1, true);
  const st = E.emptyState('1.0.0');
  const r = E.applyImport(st, res.rows, '2026-08-12T09:00:00');
  assert.strictEqual(r.imported, 4);
  assert.strictEqual(Object.keys(st.bugs).length, 4);
  assert.strictEqual(st.people.indexOf('张伟') !== -1, true);
});

// ===== 备注 / 删除记录 备份恢复 =====
test('备份/恢复：备注与删除记录完整保留', () => {
  const st = E.emptyState('1.0.0');
  E.applyImport(st, [row('B1'), row('B2')], '2026-08-12T09:00:00');
  E.setNote(st, 'B1', '已定位根因，修复中', '张伟', '2026-08-13T10:00:00');
  E.removeBug(st, 'B2', '非本团队问题', '李娜', '2026-08-13T11:00:00');

  const backup = Storage.buildBackup(st);
  const bugB1 = backup.bugs.find((b) => b['编号'] === 'B1');
  assert.ok(bugB1['__备注'].indexOf('已定位根因') !== -1);
  const delRec = backup.history.find((h) => h['变更来源'] === '删除');
  assert.ok(delRec);
  assert.strictEqual(delRec['删除原因'], '非本团队问题');
  assert.strictEqual(delRec['操作人'], '李娜');

  const restored = Storage.restoreBackup(E.emptyState('1.0.0'), backup);
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.state.bugs['B1'].sys.note.text, '已定位根因，修复中');
  assert.strictEqual(restored.state.bugs['B1'].sys.note.user, '张伟');
  assert.strictEqual(restored.state.bugs['B2'], undefined);
  const del = restored.state.history.find((h) => h.source === 'delete');
  assert.ok(del);
  assert.strictEqual(del.reason, '非本团队问题');
  assert.strictEqual(del.user, '李娜');
});

test('备份/恢复：旧备份无 __备注 字段兼容（note=null）', () => {
  const st = E.emptyState('1.0.0');
  E.applyImport(st, [row('B1')], '2026-08-12T09:00:00');
  const backup = Storage.buildBackup(st);
  delete backup.bugs[0]['__备注'];   // 模拟旧版本备份
  const restored = Storage.restoreBackup(E.emptyState('1.0.0'), backup);
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.state.bugs['B1'].sys.note, null);
});

if (pending === 0) {
  console.log(`\n结果：${passed} 通过, ${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}
