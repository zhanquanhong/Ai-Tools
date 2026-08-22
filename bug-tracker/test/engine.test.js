/**
 * engine.test.js — 核心引擎单元测试（Node 直接运行）
 * 运行：node test/engine.test.js
 */
const assert = require('assert');
const E = require('../js/engine.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

function row(id, overrides) {
  const r = {
    '编号': id, '标题': 't', '描述': '', '状态': '新建', '发现发布': 'V1.0',
    '分析原因': '', '停留天数': '0', '严重程度': '一般', '当前责任人': '张三',
    '最近修改时间': '', '创建人': '', '退回原因': '', '激活原因': '', '最近更新人': ''
  };
  Object.assign(r, overrides || {});
  return r;
}

console.log('\n=== 引擎单元测试 ===\n');

// ---------- 首次导入（基线） ----------
test('首次导入：全部记为新增，无解决', () => {
  const s = E.emptyState('1.0.0');
  const r = E.applyImport(s, [row('B1'), row('B2')], '2026-08-12T09:00:00');
  assert.strictEqual(r.imported, 2);
  assert.strictEqual(r.solved, 0);
  assert.strictEqual(s.snapshots.length, 1);
  assert.strictEqual(s.snapshots[0].totalActive, 2);
});

// ---------- 消失即解决 ----------
test('第二次导入：消失的 BUG 记为解决', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1')], '2026-08-13T09:00:00');
  assert.strictEqual(r.solved, 1);
  assert.strictEqual(r.imported, 0);
  assert.strictEqual(s.bugs['B2'].sys.lastSolvedAt, '2026-08-13T09:00:00');
  assert.strictEqual(E.isActive(s.bugs['B2']), false);
  assert.strictEqual(E.isActive(s.bugs['B1']), true);
  // 快照统计
  const stats = E.computeStats(s, 5);
  assert.strictEqual(stats.totalActive, 1);
});

// ---------- 新增与持续 ----------
test('第二次导入：新编号记为新增，共同编号持续', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1'), row('B3')], '2026-08-13T09:00:00');
  assert.strictEqual(r.imported, 1);
  assert.strictEqual(r.solved, 0);
  assert.strictEqual(s.bugs['B3'].sys.firstSeenAt, '2026-08-13T09:00:00');
});

// ---------- 重新激活 ----------
test('重新激活：曾解决又出现的 BUG 标记重新激活，不计新增', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-12T09:00:00');
  E.applyImport(s, [row('B1')], '2026-08-13T09:00:00');      // B2 消失 → 解决
  const r = E.applyImport(s, [row('B1'), row('B2')], '2026-08-14T09:00:00'); // B2 回归
  assert.strictEqual(r.reactivated, 1);
  assert.strictEqual(r.imported, 0); // 不算新增
  assert.strictEqual(s.bugs['B2'].sys.reactivatedAt, '2026-08-14T09:00:00');
  assert.strictEqual(E.isActive(s.bugs['B2']), true);
  // 首次发现日保留
  assert.strictEqual(s.bugs['B2'].sys.firstSeenAt, '2026-08-12T09:00:00');
});

// ---------- 责任人：导入覆盖 + 上次负责人 + 历史 ----------
test('责任人变更：导入覆盖并记录上次负责人与历史', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '张三' })], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1', { '当前责任人': '李四' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerChanges, 1);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '李四');
  assert.strictEqual(s.bugs['B1'].sys.prevOwner, '张三');
  assert.strictEqual(s.history.length, 1);
  assert.strictEqual(s.history[0].from, '张三');
  assert.strictEqual(s.history[0].to, '李四');
  assert.strictEqual(s.history[0].source, 'import');
});

// ---------- 连续变更：上次负责人始终是上一个值 ----------
test('责任人连续变更：prevOwner 始终为上一个值', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': 'A' })], '2026-08-12T09:00:00');
  E.applyImport(s, [row('B1', { '当前责任人': 'B' })], '2026-08-13T09:00:00');
  E.applyImport(s, [row('B1', { '当前责任人': 'C' })], '2026-08-14T09:00:00');
  assert.strictEqual(s.bugs['B1'].sys.prevOwner, 'B');
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], 'C');
  assert.strictEqual(s.history.length, 2);
  assert.strictEqual(s.history[1].from, 'B');
  assert.strictEqual(s.history[1].to, 'C');
});

// ---------- 手动改派 ----------
test('手动改派：更新责任人、标记 manual、记录历史', () => {
  const s = E.emptyState('1.0.0');
  s.people = ['张三', '王五'];
  E.applyImport(s, [row('B1', { '当前责任人': '张三' })], '2026-08-12T09:00:00');
  const r = E.reassign(s, 'B1', '王五', '2026-08-12T10:00:00', s.people);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '王五');
  assert.strictEqual(s.bugs['B1'].sys.prevOwner, '张三');
  assert.strictEqual(s.bugs['B1'].sys.manualReassigned, true);
  assert.strictEqual(s.history[0].source, 'manual');
});

test('手动改派：人员不在名单中拒绝', () => {
  const s = E.emptyState('1.0.0');
  s.people = ['张三'];
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  const r = E.reassign(s, 'B1', '不存在的人', '2026-08-12T10:00:00', s.people);
  assert.strictEqual(r.ok, false);
});

// ---------- 人员管理 ----------
test('人员：新增/重命名/删除保护', () => {
  const s = E.emptyState('1.0.0');
  assert.strictEqual(E.addPerson(s, '张三').ok, true);
  assert.strictEqual(E.addPerson(s, '张三').ok, false); // 重复
  E.applyImport(s, [row('B1', { '当前责任人': '张三' })], '2026-08-12T09:00:00');
  // 名下有未解决 BUG → 禁止删除
  const del = E.removePerson(s, '张三');
  assert.strictEqual(del.ok, false);
  assert.ok(del.error.includes('未解决'));
  // 重命名联动 BUG
  assert.strictEqual(E.renamePerson(s, '张三', '张三丰').ok, true);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '张三丰');
});

// ---------- 统计：版本/严重程度/超期 ----------
test('统计：版本分布、严重程度分布、超期判定', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0', '严重程度': '严重', '停留天数': '6' }),
    row('B2', { '发现发布': 'V1.0', '严重程度': '一般', '停留天数': '3' }),
    row('B3', { '发现发布': 'V2.0', '严重程度': '严重', '停留天数': '10' })
  ], '2026-08-12T09:00:00');
  const st = E.computeStats(s, 5);
  assert.strictEqual(st.totalActive, 3);
  assert.strictEqual(st.byVersion['V1.0'], 2);
  assert.strictEqual(st.byVersion['V2.0'], 1);
  assert.strictEqual(st.bySeverity['严重'], 2);
  assert.strictEqual(st.bySeverity['一般'], 1);
  assert.strictEqual(st.overdue, 2); // B1(6天) B3(10天)
  assert.strictEqual(st.byOwner['张三'].overdue, 2);
});

test('统计：空责任人显示未分配', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '' })], '2026-08-12T09:00:00');
  const st = E.computeStats(s, 5);
  assert.strictEqual(st.byOwner['未分配'].active, 1);
});

// ---------- 漏导防护 ----------
test('漏导防护：解决数超 30% 产生告警', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1'), row('B2'), row('B3'), row('B4')], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1')], '2026-08-13T09:00:00'); // 3/4 消失
  assert.strictEqual(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes('疑似漏导'));
});

test('漏导防护：正常解决不告警', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1'), row('B2'), row('B3'), row('B4')], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1'), row('B2'), row('B3')], '2026-08-13T09:00:00'); // 1/4
  assert.strictEqual(r.warnings.length, 0);
});

// ---------- 同次导入重复编号 ----------
test('同次导入重复编号：去重取最后一行', () => {
  const s = E.emptyState('1.0.0');
  const r = E.applyImport(s, [
    row('B1', { '当前责任人': '张三' }),
    row('B1', { '当前责任人': '李四' })
  ], '2026-08-12T09:00:00');
  assert.strictEqual(r.imported, 1);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '李四');
});

// ---------- 7 日趋势 ----------
test('7 日趋势：按快照聚合，缺天显示无数据', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-12T15:00:00');
  E.applyImport(s, [row('B1')], '2026-08-13T09:00:00');
  const t = E.trend7(s, '2026-08-13T12:00:00', 7);
  assert.strictEqual(t.length, 7);
  const d12 = t.find((d) => d.date === '2026-08-12');
  assert.strictEqual(d12.imported, 2); // 两次导入合并
  assert.strictEqual(d12.solved, 0);   // 08-12 无消失
  const d13 = t.find((d) => d.date === '2026-08-13');
  assert.strictEqual(d13.solved, 1);   // B2 消失
  const d10 = t.find((d) => d.date === '2026-08-10');
  assert.strictEqual(d10.hasData, false);
});

test('趋势：天数可配置（14/30/90 天），非法值兜底 7', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  assert.strictEqual(E.trend7(s, '2026-08-12T12:00:00', 14).length, 14);
  assert.strictEqual(E.trend7(s, '2026-08-12T12:00:00', 30).length, 30);
  assert.strictEqual(E.trend7(s, '2026-08-12T12:00:00', 90).length, 90);
  assert.strictEqual(E.trend7(s, '2026-08-12T12:00:00', 'abc').length, 7);
  assert.strictEqual(E.trend7(s, '2026-08-12T12:00:00', 0).length, 7);
  assert.strictEqual(E.trend7(s, '2026-08-12T12:00:00', 999).length, 90);
});

// ---------- 原始负责人保护 ----------
test('责任人字段解析：唐朝汉/曾卓彬 → 实际=曾卓彬，原始=唐朝汉', () => {
  const p = E.parseOwnerField('唐朝汉/曾卓彬');
  assert.strictEqual(p.owner, '曾卓彬');
  assert.strictEqual(p.originalOwner, '唐朝汉');
  assert.deepStrictEqual(E.parseOwnerField('唐朝汉'), { owner: '唐朝汉', originalOwner: '唐朝汉' });
  assert.deepStrictEqual(E.parseOwnerField(''), { owner: '未分配', originalOwner: '' });
  assert.deepStrictEqual(E.parseOwnerField('  '), { owner: '未分配', originalOwner: '' });
});

test('原始负责人保护：已分配 BUG 重新导入原始负责人不覆盖', () => {
  const s = E.emptyState('1.0.0');
  // 首次导入：唐朝汉
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-12T09:00:00');
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '唐朝汉');
  assert.strictEqual(s.bugs['B1'].sys.originalOwner, '唐朝汉');
  // 第二次导入：唐朝汉/曾卓彬 → 已分配给曾卓彬
  let r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉/曾卓彬' })], '2026-08-13T09:00:00');
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '曾卓彬');
  assert.strictEqual(s.bugs['B1'].sys.originalOwner, '唐朝汉');
  assert.strictEqual(r.ownerChanges, 1);
  // 第三次导入：源系统原始列表仍是 唐朝汉 → 保护跳过，保留曾卓彬
  r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-14T09:00:00');
  assert.strictEqual(r.ownerSkipped, 1);
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '曾卓彬');
  assert.strictEqual(s.bugs['B1'].sys.prevOwner, '唐朝汉'); // 未被覆盖
  // 历史只有 1 条（唐朝汉→曾卓彬）
  assert.strictEqual(s.history.length, 1);
});

test('保护规则：白名单内部流转（王东鸿→胡宁）也保护（导入=白名单且≠系统）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '王东鸿' })], '2026-08-12T09:00:00');
  let r = E.applyImport(s, [row('B1', { '当前责任人': '胡宁' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(r.ownerSkipped, 1);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '王东鸿');
});

test('原始负责人保护：无斜杠直接改派（真实改派，名单外人员）正常覆盖', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉/曾卓彬' })], '2026-08-12T09:00:00');
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '曾卓彬');
  // 源系统直接写新责任人（无斜杠，名单外人员）→ 真实改派，应覆盖
  const r = E.applyImport(s, [row('B1', { '当前责任人': '刘洋' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerChanges, 1);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '刘洋');
});

test('名单保护：导入带斜杠的名单内人员分配（唐朝汉/陈培生）→ 正常覆盖为陈培生', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-12T09:00:00');
  // 源系统已分配：唐朝汉/陈培生 → 正常更新为陈培生
  const r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉/陈培生' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerChanges, 1);
  assert.strictEqual(r.ownerSkipped, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '陈培生');
  // 再次导入原始列表 唐朝汉 → 跳过，保留陈培生
  const r2 = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-14T09:00:00');
  assert.strictEqual(r2.ownerSkipped, 1);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '陈培生');
});

test('原始负责人保护：多级分配 唐朝汉/曾卓彬/熊乘风 → 实际=熊乘风', () => {
  const p = E.parseOwnerField('唐朝汉/曾卓彬/熊乘风');
  assert.strictEqual(p.owner, '熊乘风');
  assert.strictEqual(p.originalOwner, '唐朝汉');
});

test('原始负责人保护：首次导入即含斜杠，原始负责人正确记录', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '胡宁/詹泉宏' })], '2026-08-12T09:00:00');
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '詹泉宏');
  assert.strictEqual(s.bugs['B1'].sys.originalOwner, '胡宁');
  // 再导入原始负责人 → 跳过
  const r = E.applyImport(s, [row('B1', { '当前责任人': '胡宁' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerSkipped, 1);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '詹泉宏');
});

test('名单兜底保护：旧数据无原始负责人字段，导入名单内人员不覆盖已分配责任人', () => {
  const s = E.emptyState('1.0.0');
  // 模拟旧数据：手动构造无 originalOwner 的记录（v1.1.0 及以前导入的数据）
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-12T09:00:00');
  s.bugs['B1'].sys.originalOwner = ''; // 旧数据无此字段
  // 用户已分配：当前责任人被改为 陈培生（名单外）
  s.bugs['B1'].fields['当前责任人'] = '陈培生';
  // 重新导入：源系统原始列表仍是 唐朝汉（名单内）→ 应跳过，保留陈培生
  const r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerSkipped, 1);
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '陈培生');
});

test('保护规则：白名单内部流转（唐朝汉→王东鸿）同样保护', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-12T09:00:00');
  s.bugs['B1'].sys.originalOwner = '';
  const r = E.applyImport(s, [row('B1', { '当前责任人': '王东鸿' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerSkipped, 1);
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '唐朝汉');
});

test('名单兜底保护：导入名单内人员、当前是名单外人员但相同 → 无变更不误伤', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '熊乘风/刘洋' })], '2026-08-12T09:00:00');
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '刘洋');
  // 再导入同一分配格式 → 责任人相同，无变更、无跳过
  const r = E.applyImport(s, [row('B1', { '当前责任人': '熊乘风/刘洋' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerSkipped, 0);
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '刘洋');
});

// ---------- 字段不更新规则（v1.3.0） ----------
test('同编号已存在：静态字段不更新，动态字段更新（v1.23.0 起版本随导入更新；v1.33.1 起严重程度随导入更新；v1.41.0 起标题随导入更新）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', {
    '标题': '原标题', '描述': '原描述', '发现发布': 'V1.0', '严重程度': '严重',
    '创建人': '测试组', '状态': '新建', '停留天数': '1'
  })], '2026-08-12T09:00:00');
  // 第二次导入：描述/创建人（静态）→ 不更新；标题（v1.41.0）→ 随导入更新；版本/严重程度（v1.23.0/v1.33.1）→ 以最新导入为准更新
  E.applyImport(s, [row('B1', {
    '标题': '新标题', '描述': '新描述', '发现发布': 'V2.0', '严重程度': '轻微',
    '创建人': '产品组', '状态': '处理中', '停留天数': '5'
  })], '2026-08-13T09:00:00');
  const f = s.bugs['B1'].fields;
  assert.strictEqual(f['标题'], '新标题');        // v1.41.0：标题随导入更新
  assert.strictEqual(f['描述'], '原描述');        // 不更新
  assert.strictEqual(f['发现发布'], 'V2.0');      // v1.23.0：以最新导入版本号为准同步更新
  assert.strictEqual(f['严重程度'], '轻微');      // v1.33.1：以最新导入严重程度为准同步更新
  assert.strictEqual(f['创建人'], '测试组');      // 不更新
  assert.strictEqual(f['状态'], '处理中');        // 更新
  assert.strictEqual(f['停留天数'], '5');         // 更新
  // v1.41.0：标题变更写入导入变更历史明细
  const last = s.history[s.history.length - 1];
  assert.ok(last.changes && last.changes.find((c) => c.field === '标题'));
  assert.deepStrictEqual(last.changes.find((c) => c.field === '标题'), { field: '标题', from: '原标题', to: '新标题' });
});

test('导入版本变更：检测并返回变更明细，系统同步为新版本（v1.23.0）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '发现发布': 'V1.0', '状态': '新建' })], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1', { '发现发布': 'V2.0', '状态': '新建' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.versionChanges.length, 1);
  assert.deepStrictEqual(r.versionChanges[0], { id: 'B1', from: 'V1.0', to: 'V2.0' });
  assert.strictEqual(s.bugs['B1'].fields['发现发布'], 'V2.0');
  // 版本未变不记录
  const r2 = E.applyImport(s, [row('B1', { '发现发布': 'V2.0', '状态': '新建' })], '2026-08-14T09:00:00');
  assert.strictEqual(r2.versionChanges.length, 0);
});

test('updateVersion：手动修改版本 + 历史留痕（v1.23.0）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '发现发布': 'V1.0', '状态': '新建' })], '2026-08-12T09:00:00');
  const r = E.updateVersion(s, 'B1', 'V3.0', '2026-08-15T10:00:00', '测试员');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.bugs['B1'].fields['发现发布'], 'V3.0');
  const last = s.history[s.history.length - 1];
  assert.strictEqual(last.source, 'verchange');
  assert.strictEqual(last.from, 'V1.0');
  assert.strictEqual(last.to, 'V3.0');
  // 同版本不重复记录
  const r2 = E.updateVersion(s, 'B1', 'V3.0', '2026-08-15T11:00:00', '测试员');
  assert.strictEqual(r2.changed, false);
  // 空版本拒绝
  const r3 = E.updateVersion(s, 'B1', '  ', '2026-08-15T11:00:00', '测试员');
  assert.strictEqual(r3.ok, false);
});

test('导入字段变更明细：记录变化的字段与日期（v1.24.0）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '状态': '新建', '停留天数': '1', '发现发布': 'V1.0' })], '2026-08-12T09:00:00');
  E.applyImport(s, [row('B1', { '状态': '处理中', '停留天数': '5', '发现发布': 'V1.0' })], '2026-08-13T09:00:00');
  const last = s.history[s.history.length - 1];
  assert.strictEqual(last.source, 'import');
  assert.strictEqual(last.at, '2026-08-13T09:00:00');
  assert.ok(last.changes && last.changes.length >= 2);
  assert.deepStrictEqual(last.changes.find((c) => c.field === '状态'), { field: '状态', from: '新建', to: '处理中' });
  assert.deepStrictEqual(last.changes.find((c) => c.field === '停留天数'), { field: '停留天数', from: '1', to: '5' });
  // 无变化的导入不产生明细记录
  const n = s.history.length;
  E.applyImport(s, [row('B1', { '状态': '处理中', '停留天数': '5', '发现发布': 'V1.0' })], '2026-08-14T09:00:00');
  assert.strictEqual(s.history.length, n);
});

test('场景B：系统=白名单/xxx，导入=白名单/yyy → 只更新责任人为 yyy', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉/陈培生', '状态': '新建' })], '2026-08-12T09:00:00');
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '陈培生');
  // 导入 唐朝汉/刘洋 → 更新为刘洋
  const r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉/刘洋', '状态': '处理中' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerChanges, 1);
  assert.strictEqual(r.ownerSkipped, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '刘洋');
  assert.strictEqual(s.bugs['B1'].sys.originalOwner, '唐朝汉');
  // 历史记录 陈培生 → 刘洋
  assert.strictEqual(s.history[s.history.length - 1].from, '陈培生');
  assert.strictEqual(s.history[s.history.length - 1].to, '刘洋');
});

test('场景A：系统=白名单/xxx，导入=白名单 → 完全不更新责任人', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉/陈培生' })], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerSkipped, 1);
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '陈培生');
});

test('场景C：导入=非白名单人员（无斜杠）→ 更新责任人（真实改派）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉/陈培生' })], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1', { '当前责任人': '刘洋' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerChanges, 1);
  assert.strictEqual(r.ownerSkipped, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '刘洋');
});

// ---------- 版本筛选（v1.4.0） ----------
test('快照记录含版本维度明细', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B2', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B2', { '发现发布': 'V2.0' }),
    row('B3', { '发现发布': 'V1.0' })
  ], '2026-08-13T09:00:00');
  const snap = s.snapshots[1];
  assert.ok(snap.byVersion);
  assert.strictEqual(snap.byVersion['V1.0'].imported, 1); // B3
  assert.strictEqual(snap.byVersion['V1.0'].solved, 0);
  assert.strictEqual(snap.byVersion['V2.0'], undefined);  // V2.0 无变化，无键
});

test('版本筛选：统计卡/严重程度/责任人维度按版本过滤', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0', '严重程度': '严重', '当前责任人': '张三', '停留天数': '6' }),
    row('B2', { '发现发布': 'V2.0', '严重程度': '一般', '当前责任人': '李四', '停留天数': '2' }),
    row('B3', { '发现发布': 'V1.0', '严重程度': '严重', '当前责任人': '张三', '停留天数': '3' })
  ], '2026-08-12T09:00:00');
  // 筛选 V1.0
  const st = E.computeStats(s, 5, 'V1.0');
  assert.strictEqual(st.totalActive, 2);
  assert.strictEqual(st.bySeverity['严重'], 2);
  assert.strictEqual(st.bySeverity['一般'], undefined);
  assert.strictEqual(st.byOwner['张三'].active, 2);
  assert.strictEqual(st.byOwner['李四'], undefined);
  assert.strictEqual(st.overdue, 1); // B1 6天
  // 筛选 V2.0
  const st2 = E.computeStats(s, 5, 'V2.0');
  assert.strictEqual(st2.totalActive, 1);
  assert.strictEqual(st2.byOwner['李四'].active, 1);
  // 全部
  const stAll = E.computeStats(s, 5, '');
  assert.strictEqual(stAll.totalActive, 3);
});

test('版本筛选：趋势按版本聚合', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B2', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B9', { '发现发布': 'V2.0' })
  ], '2026-08-13T09:00:00'); // 全量（V1.0/V2.0 均在范围），B2 消失 → V2.0 解决
  const tAll = E.trend7(s, '2026-08-13T12:00:00', 7, '');
  const d13All = tAll.find((d) => d.date === '2026-08-13');
  assert.strictEqual(d13All.solved, 1);
  const tV1 = E.trend7(s, '2026-08-13T12:00:00', 7, 'V1.0');
  const d13V1 = tV1.find((d) => d.date === '2026-08-13');
  assert.strictEqual(d13V1.solved, 0);  // V1.0 无解决
  const d12V1 = tV1.find((d) => d.date === '2026-08-12');
  assert.strictEqual(d12V1.imported, 1); // 只有 B1
  const tV2 = E.trend7(s, '2026-08-13T12:00:00', 7, 'V2.0');
  const d13V2 = tV2.find((d) => d.date === '2026-08-13');
  assert.strictEqual(d13V2.solved, 1);   // V2.0 解决 1
  const d12V2 = tV2.find((d) => d.date === '2026-08-12');
  assert.strictEqual(d12V2.imported, 1);
});

test('保护规则：导入=白名单且与系统不同（系统也是白名单）→ 不更新责任人', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '王东鸿' })], '2026-08-12T09:00:00');
  s.bugs['B1'].sys.originalOwner = ''; // 模拟旧数据
  // 导入 唐朝汉（白名单，与系统王东鸿不同）→ 不更新责任人，但更新其他字段
  const r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉', '状态': '处理中' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerSkipped, 1);
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '王东鸿');
  assert.strictEqual(s.bugs['B1'].fields['状态'], '处理中'); // 其他字段照常更新
});

test('保护规则：导入=白名单且与系统相同 → 无变更不误伤', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B1', { '当前责任人': '唐朝汉' })], '2026-08-13T09:00:00');
  assert.strictEqual(r.ownerSkipped, 0);
  assert.strictEqual(r.ownerChanges, 0);
  assert.strictEqual(s.bugs['B1'].fields['当前责任人'], '唐朝汉');
});

// ---------- 问题清单导出（v1.5.0） ----------
test('问题清单：按责任人分组、数量降序、格式正确', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '当前责任人': '黄翔' }),
    row('B2', { '当前责任人': '张俊祺' }),
    row('B3', { '当前责任人': '黄翔' }),
    row('B4', { '当前责任人': '黄翔' }),
    row('B5', { '当前责任人': '张俊祺' })
  ], '2026-08-12T09:00:00');
  const recs = Object.keys(s.bugs).map((id) => s.bugs[id]).filter((r) => E.isActive(r));
  const groups = E.buildOwnerBugList(recs);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].owner, '黄翔');      // 数量多排前
  assert.strictEqual(groups[0].count, 3);
  assert.strictEqual(groups[1].owner, '张俊祺');
  assert.strictEqual(groups[1].count, 2);
  // 文本格式
  const text = E.buildBugListText(recs);
  const lines = text.split('\n');
  assert.ok(lines[0].indexOf('黄翔（3）') !== -1);
  assert.ok(lines.includes('B1'));
  assert.ok(lines.includes('B4'));
  const zhangIdx = lines.findIndex((l) => l.indexOf('张俊祺（2）') !== -1);
  assert.ok(zhangIdx > 3);
  assert.ok(lines.includes('B2'));
});

test('问题清单：按版本筛选导出', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '当前责任人': '黄翔', '发现发布': 'V1.0' }),
    row('B2', { '当前责任人': '黄翔', '发现发布': 'V2.0' }),
    row('B3', { '当前责任人': '张俊祺', '发现发布': 'V1.0' })
  ], '2026-08-12T09:00:00');
  const recs = Object.keys(s.bugs).map((id) => s.bugs[id]).filter((r) => E.isActive(r) && (r.fields['发现发布'] || '').trim() === 'V1.0');
  const text = E.buildBugListText(recs);
  assert.ok(text.indexOf('黄翔（1）') !== -1);
  assert.ok(text.indexOf('张俊祺（1）') !== -1);
  assert.ok(text.indexOf('B2') === -1); // V2.0 不在
});

test('问题清单：空列表返回空文本', () => {
  const text = E.buildBugListText([]);
  assert.strictEqual(text, '');
});

test('动态筛选：编号列多单号匹配（ids 类型）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '标题': 'a' }),
    row('B2', { '标题': 'b' }),
    row('B3', { '标题': 'c' })
  ], '2026-08-12T09:00:00');
  const recs = Object.values(s.bugs);
  let r = E.filterRecords(recs, { '编号': { type: 'ids', value: ['B1', 'B3'] } });
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map((x) => x.id).sort(), ['B1', 'B3']);
  r = E.filterRecords(recs, { '编号': { type: 'ids', value: ['B2'] } });
  assert.strictEqual(r.length, 1);
  r = E.filterRecords(recs, { '编号': { type: 'ids', value: [] } });
  assert.strictEqual(r.length, 3); // 空列表不过滤
});

// ---------- 多版本筛选（v1.6.0） ----------
test('多版本筛选：computeStats 支持数组（任一匹配）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B2', { '发现发布': 'V2.0' }),
    row('B3', { '发现发布': 'V3.0' })
  ], '2026-08-12T09:00:00');
  const st = E.computeStats(s, 5, ['V1.0', 'V2.0']);
  assert.strictEqual(st.totalActive, 2);
  const st2 = E.computeStats(s, 5, ['V1.0']);
  assert.strictEqual(st2.totalActive, 1);
  const st3 = E.computeStats(s, 5, []);
  assert.strictEqual(st3.totalActive, 3);
});

test('多版本筛选：趋势按多版本聚合', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B2', { '发现发布': 'V2.0' }),
    row('B3', { '发现发布': 'V3.0' })
  ], '2026-08-12T09:00:00');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B9', { '发现发布': 'V2.0' }),
    row('B10', { '发现发布': 'V3.0' })
  ], '2026-08-13T09:00:00'); // 全量，B2 B3 消失
  const t = E.trend7(s, '2026-08-13T12:00:00', 7, ['V2.0', 'V3.0']);
  const d13 = t.find((d) => d.date === '2026-08-13');
  assert.strictEqual(d13.solved, 2);
  const d12 = t.find((d) => d.date === '2026-08-12');
  assert.strictEqual(d12.imported, 2);
  // 单版本
  const t2 = E.trend7(s, '2026-08-13T12:00:00', 7, 'V2.0');
  assert.strictEqual(t2.find((d) => d.date === '2026-08-13').solved, 1);
});

// ---------- 动态筛选 ----------
test('动态筛选：枚举多选/文本/数字范围/日期范围', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '严重程度': '严重', '停留天数': '6', '最近修改时间': '2026-08-10 10:00', '标题': '登录失败' }),
    row('B2', { '严重程度': '一般', '停留天数': '2', '最近修改时间': '2026-08-12 10:00', '标题': '导出乱码' }),
    row('B3', { '严重程度': '严重', '停留天数': '9', '最近修改时间': '2026-08-11 10:00', '标题': '支付超时' })
  ], '2026-08-12T09:00:00');
  const recs = Object.values(s.bugs);
  // 枚举
  let r = E.filterRecords(recs, { '严重程度': { type: 'enum', value: ['严重'] } });
  assert.strictEqual(r.length, 2);
  // 文本
  r = E.filterRecords(recs, { '标题': { type: 'text', value: '乱码' } });
  assert.strictEqual(r.length, 1);
  // 数字范围
  r = E.filterRecords(recs, { '停留天数': { type: 'number', min: 5, max: 10 } });
  assert.strictEqual(r.length, 2);
  // 日期范围
  r = E.filterRecords(recs, { '最近修改时间': { type: 'date', from: '2026-08-11', to: '2026-08-12' } });
  assert.strictEqual(r.length, 2);
  // 组合 AND
  r = E.filterRecords(recs, {
    '严重程度': { type: 'enum', value: ['严重'] },
    '停留天数': { type: 'number', min: 5 }
  });
  assert.strictEqual(r.length, 2);
});

// ---------- CSV 编码检测 ----------
function bytesOf(str, enc) {
  const b = Buffer.from(str, enc);
  return Array.from(b);
}
test('编码检测：UTF-8 无 BOM', () => {
  assert.strictEqual(E.detectCsvEncoding(bytesOf('编号,标题', 'utf8')), 'utf-8');
});
test('编码检测：UTF-8 BOM', () => {
  const b = [0xEF, 0xBB, 0xBF].concat(bytesOf('编号,标题', 'utf8'));
  assert.strictEqual(E.detectCsvEncoding(b), 'utf-8-bom');
});
test('编码检测：GBK 中文', () => {
  // GBK: 编=B1E0 号=BAC5 标=B1EA 题=CCE2
  const b = [0xB1, 0xE0, 0xBA, 0xC5, 0x2C, 0xB1, 0xEA, 0xCC, 0xE2];
  assert.strictEqual(E.detectCsvEncoding(b), 'gbk');
});
test('编码检测：UTF-16 LE', () => {
  const b = [0xFF, 0xFE].concat(bytesOf('编号', 'utf16le'));
  assert.strictEqual(E.detectCsvEncoding(b), 'utf-16le');
});

// ---------- 导入空编号 ----------
test('空编号行被忽略', () => {
  const s = E.emptyState('1.0.0');
  const r = E.applyImport(s, [row(''), row('B1')], '2026-08-12T09:00:00');
  assert.strictEqual(r.imported, 1);
});

// ---------- 版本统计卡片数据源 versionCounts（v1.9.1） ----------
test('快照 versionCounts = 本次导入去重后各版本条数（含已存在/已解决行）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B2', { '发现发布': 'V1.0' }),
    row('B3', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),            // 已存在
    row('B4', { '发现发布': 'V3.0' }),            // 新增
    row('B4', { '发现发布': 'V3.0' }),            // 同批重复 → 去重
    row('B5', { '发现发布': 'V2.0', '状态': '已解决' })  // 已解决状态行也计入
  ], '2026-08-13T09:00:00');
  const snap = s.snapshots[1];
  assert.deepStrictEqual(snap.versionCounts, { 'V1.0': 1, 'V3.0': 1, 'V2.0': 1 });
  // 第一次导入的快照同样有 versionCounts
  assert.deepStrictEqual(s.snapshots[0].versionCounts, { 'V1.0': 2, 'V2.0': 1 });
});

test('versionCounts：空版本兜底为未标注', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': '' }),
    row('B2', { '发现发布': 'V1.0' })
  ], '2026-08-13T09:00:00');
  assert.deepStrictEqual(s.snapshots[0].versionCounts, { '未标注': 1, 'V1.0': 1 });
});

// ---------- 存量数据迁移 migrateState（v1.10.0） ----------
test('migrateState：旧快照补齐 versionCounts（以当前全量版本兜底）', () => {
  const s = E.emptyState('1.8.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B2', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }),
    row('B3', { '发现发布': 'V1.0' })
  ], '2026-08-13T09:00:00');
  // 模拟旧版：剥掉 versionCounts + 旧 appVersion
  s.appVersion = '1.8.0';
  s.snapshots.forEach((sn) => { delete sn.versionCounts; });
  const mig = E.migrateState(s, '1.10.0');
  assert.strictEqual(mig.changed, true);
  assert.strictEqual(s.appVersion, '1.10.0');
  // 最近快照补齐：当前 bugs = B1(V1.0), B2(V2.0), B3(V1.0) → V1.0:2, V2.0:1
  assert.deepStrictEqual(s.snapshots[1].versionCounts, { 'V1.0': 2, 'V2.0': 1 });
  // 迁移兜底值带 vcFallback 标记（区别于真实导入）；仅最近快照被处理（看板数据源）
  assert.strictEqual(s.snapshots[1].vcFallback, true);
  assert.strictEqual(s.snapshots[0].vcFallback, undefined);
});

test('migrateState：幂等（重复执行无副作用）', () => {
  const s = E.emptyState('1.8.0');
  E.applyImport(s, [row('B1', { '发现发布': 'V1.0' })], '2026-08-13T09:00:00');
  s.appVersion = '1.8.0';
  delete s.snapshots[0].versionCounts;
  E.migrateState(s, '1.10.0');
  const again = E.migrateState(s, '1.10.0');
  assert.strictEqual(again.changed, false);
  assert.strictEqual(s.appVersion, '1.10.0');
});

test('migrateState：新版本数据（已有 versionCounts）不迁移', () => {
  const s = E.emptyState('1.9.1');
  E.applyImport(s, [row('B1', { '发现发布': 'V1.0' })], '2026-08-13T09:00:00');
  const mig = E.migrateState(s, '1.10.0');
  assert.strictEqual(mig.changed, false);
});

test('versionLessThan：版本号比较正确', () => {
  assert.strictEqual(E.versionLessThan('1.8.0', '1.9.1'), true);
  assert.strictEqual(E.versionLessThan('1.9.1', '1.9.1'), false);
  assert.strictEqual(E.versionLessThan('1.10.0', '1.9.1'), false);
  assert.strictEqual(E.versionLessThan('0', '1.9.1'), true);
  assert.strictEqual(E.versionLessThan('2.0.0', '1.9.1'), false);
});

// ---------- 范围感知消失判定 + 撤销（v1.11.0） ----------
test('范围判定：全量导入 → 消失=解决（等价旧逻辑）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }), row('B2', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  // 全量：V1.0+V2.0 均在本次数据中（B9 为 V1.0 新 BUG），B1 消失 → 判定解决
  const r = E.applyImport(s, [
    row('B2', { '发现发布': 'V2.0', '状态': '处理中' }),
    row('B9', { '发现发布': 'V1.0' })
  ], '2026-08-13T09:00:00');
  assert.strictEqual(r.solved, 1);       // B1 消失
  assert.strictEqual(E.isActive(s.bugs['B1']), false);
  assert.strictEqual(E.isActive(s.bugs['B2']), true);
});

test('范围判定：部分版本导入 → 其他版本活跃 BUG 不被误判', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }), row('B2', { '发现发布': 'V2.0' }), row('B3', { '发现发布': 'V3.0' })
  ], '2026-08-12T09:00:00');
  // 只导 V2.0 存量：B1(V1.0)、B3(V3.0) 不在范围 → 不动；B2 仍在 → 无消失
  const r = E.applyImport(s, [
    row('B2', { '发现发布': 'V2.0', '状态': '处理中' })
  ], '2026-08-13T09:00:00');
  assert.strictEqual(r.solved, 0);
  assert.strictEqual(E.isActive(s.bugs['B1']), true);
  assert.strictEqual(E.isActive(s.bugs['B3']), true);
});

test('范围判定：部分版本导入 → 范围内消失判定解决', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }), row('B2', { '发现发布': 'V2.0' }), row('B3', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  // 只导 V2.0 存量：B3 消失（V2.0 范围内）→ 解决；B1(V1.0) 不动
  const r = E.applyImport(s, [
    row('B2', { '发现发布': 'V2.0' })
  ], '2026-08-13T09:00:00');
  assert.strictEqual(r.solved, 1);
  assert.strictEqual(E.isActive(s.bugs['B3']), false);
  assert.strictEqual(E.isActive(s.bugs['B1']), true);
});

test('范围判定：版本匹配（按版本导入，版本内消失即解决，其他版本不动）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0', '当前责任人': '张三' }),
    row('B2', { '发现发布': 'V1.0', '当前责任人': '李四' }),
    row('B3', { '发现发布': 'V2.0', '当前责任人': '王五' })
  ], '2026-08-12T09:00:00');
  // 只导 V1.0（张三的问题）：V={V1.0} → B2(V1.0 李四) 消失 → 解决；B3(V2.0) 不在范围 → 不动
  const r = E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0', '当前责任人': '张三', '状态': '处理中' })
  ], '2026-08-13T09:00:00');
  assert.strictEqual(r.solved, 1);
  assert.strictEqual(E.isActive(s.bugs['B2']), false);
  assert.strictEqual(E.isActive(s.bugs['B3']), true);
});

test('范围判定：跨版本人员交集（张伟 V1.0+V2.0，只导 V2.0 → V1.0 不动）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0', '当前责任人': '张伟' }),
    row('B2', { '发现发布': 'V2.0', '当前责任人': '张伟' }),
    row('B3', { '发现发布': 'V2.0', '当前责任人': '李四' }),
    row('B4', { '发现发布': 'V2.0', '当前责任人': '李四' })
  ], '2026-08-12T09:00:00');
  // 只导 V2.0 全量（张伟+李四的问题）：B4 消失 → 解决；B1(V1.0 张伟) 不在范围 → 不动
  const r = E.applyImport(s, [
    row('B2', { '发现发布': 'V2.0', '当前责任人': '张伟' }),
    row('B3', { '发现发布': 'V2.0', '当前责任人': '李四' })
  ], '2026-08-13T09:00:00');
  assert.strictEqual(r.solved, 1);       // 仅 B4
  assert.strictEqual(E.isActive(s.bugs['B1']), true);
  assert.strictEqual(E.isActive(s.bugs['B4']), false);
});

test('undoSolved：恢复活跃 + 修正最近快照 solved 计数', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V1.0' }), row('B2', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [
    row('B2', { '发现发布': 'V2.0' }),
    row('B9', { '发现发布': 'V1.0' })   // 全量覆盖：B1 消失 → 解决
  ], '2026-08-13T09:00:00');
  assert.strictEqual(r.solved, 1);
  assert.strictEqual(s.snapshots[1].solved, 1);
  // 撤销
  const n = E.undoSolved(s, r.solvedIds);
  assert.strictEqual(n, 1);
  assert.strictEqual(E.isActive(s.bugs['B1']), true);
  assert.strictEqual(s.snapshots[1].solved, 0);
  assert.strictEqual(s.snapshots[1].byVersion['V1.0'].solved, 0);
});

test('undoSolved：重复撤销幂等（第二次返回 0）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '发现发布': 'V1.0' })], '2026-08-12T09:00:00');
  const r = E.applyImport(s, [row('B9', { '发现发布': 'V1.0' })], '2026-08-13T09:00:00'); // V1.0 在范围，B1 消失
  assert.strictEqual(r.solved, 1);
  assert.strictEqual(E.undoSolved(s, r.solvedIds), 1);
  assert.strictEqual(E.undoSolved(s, r.solvedIds), 0);
});

// ---------- 备注 ----------
test('setNote：设置备注（含操作人/时间），导入不覆盖', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-12T09:00:00');
  const r = E.setNote(s, 'B1', '已定位根因，修复中', '张伟', '2026-08-13T10:00:00');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cleared, false);
  assert.deepStrictEqual(s.bugs['B1'].sys.note, { text: '已定位根因，修复中', at: '2026-08-13T10:00:00', user: '张伟' });
  // 重新导入：备注保留
  E.applyImport(s, [row('B1', { '状态': '处理中' }), row('B2')], '2026-08-14T09:00:00');
  assert.strictEqual(s.bugs['B1'].sys.note.text, '已定位根因，修复中');
  assert.strictEqual(s.bugs['B2'].sys.note, null);
});

test('setNote：空内容清除备注', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  E.setNote(s, 'B1', '测试备注', '李娜', '2026-08-13T10:00:00');
  const r = E.setNote(s, 'B1', '   ', '李娜', '2026-08-14T10:00:00');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(s.bugs['B1'].sys.note, null);
});

test('setNote：BUG 不存在返回错误', () => {
  const s = E.emptyState('1.0.0');
  const r = E.setNote(s, 'NOPE', 'x', '张伟', '2026-08-13T10:00:00');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

// ---------- 删除 ----------
test('removeBug：删除 + 历史留痕（原因/操作人）+ 看板统计同步减少', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '标题': '登录失败', '发现发布': 'V1.0', '当前责任人': '张伟' }),
    row('B2', { '发现发布': 'V1.0', '当前责任人': '李娜' }),
    row('B3', { '发现发布': 'V2.0' })
  ], '2026-08-12T09:00:00');
  const st1 = E.computeStats(s, 5);
  assert.strictEqual(st1.totalActive, 3);
  assert.strictEqual(st1.byVersion['V1.0'], 2);

  const r = E.removeBug(s, 'B1', '非本团队问题', '张伟', '2026-08-13T10:00:00');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.bugs['B1'], undefined);

  // 历史留痕
  const del = s.history.filter((h) => h.id === 'B1' && h.source === 'delete');
  assert.strictEqual(del.length, 1);
  assert.strictEqual(del[0].reason, '非本团队问题');
  assert.strictEqual(del[0].user, '张伟');
  assert.strictEqual(del[0].title, '登录失败');

  // 统计同步减少：未解决 3→2，版本 V1.0 2→1
  const st2 = E.computeStats(s, 5);
  assert.strictEqual(st2.totalActive, 2);
  assert.strictEqual(st2.byVersion['V1.0'], 1);
  assert.strictEqual(st2.byOwner['张伟'], undefined);
  // 最近快照同步修正
  const last = s.snapshots[s.snapshots.length - 1];
  assert.strictEqual(last.totalActive, 2);
  assert.strictEqual(last.versionCounts['V1.0'], 1);
});

test('removeBug：原因必填', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  const r = E.removeBug(s, 'B1', '   ', '张伟', '2026-08-13T10:00:00');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('原因') !== -1);
  assert.ok(s.bugs['B1']);
});

test('removeBug：BUG 不存在返回错误', () => {
  const s = E.emptyState('1.0.0');
  const r = E.removeBug(s, 'NOPE', 'x', '张伟', '2026-08-13T10:00:00');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('removeBug：删除已解决 BUG 不减少未解决总数', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-12T09:00:00');
  // 第二次导入：B1 消失 → 已解决
  E.applyImport(s, [row('B2')], '2026-08-13T09:00:00');
  assert.strictEqual(E.isActive(s.bugs['B1']), false);
  const before = E.computeStats(s, 5).totalActive;
  E.removeBug(s, 'B1', '误导入', '张伟', '2026-08-13T10:00:00');
  assert.strictEqual(E.computeStats(s, 5).totalActive, before);
});

// ---------- 编号清洗 + 未导入提示 ----------
test('cleanId：去除全角空格/换行/零宽字符', () => {
  assert.strictEqual(E.cleanId(' BUG001 '), 'BUG001');
  assert.strictEqual(E.cleanId('BUG\u3000001'), 'BUG 001');   // 全角空格 → 半角
  assert.strictEqual(E.cleanId('BUG001\r\n'), 'BUG001');      // 换行去除
  assert.strictEqual(E.cleanId('BUG\u200B001'), 'BUG001');    // 零宽字符去除
  assert.strictEqual(E.cleanId('\uFEFFBUG001'), 'BUG001');    // BOM 去除
  assert.strictEqual(E.cleanId('  \u3000  '), '');
});

test('导入：缺编号行被统计进 skippedRows（不静默丢失）', () => {
  const s = E.emptyState('1.0.0');
  const rows = [
    row('B1', { '标题': '正常行' }),
    { '标题': '缺编号行', '状态': '新建' },          // 无编号
    row('B2', { '标题': '另一行' }),
    { '编号': '   \u3000  ', '标题': '全空格编号行' }  // 编号清洗后为空
  ];
  const r = E.applyImport(s, rows, '2026-08-14T06:00:00');
  assert.strictEqual(r.imported, 2);
  assert.ok(s.bugs['B1'] && s.bugs['B2']);
  assert.strictEqual(r.skippedRows.length, 2);
  assert.strictEqual(r.skippedRows[0].row, 3);       // 文件第 3 行（idx=1 + 2）
  assert.ok(r.skippedRows[0].hint.indexOf('缺编号行') !== -1);
  assert.strictEqual(r.skippedRows[1].row, 5);
});

test('导入：编号含隐藏字符被清洗并记录 cleanedIds', () => {
  const s = E.emptyState('1.0.0');
  const rows = [
    { '编号': 'B1\u3000', '标题': '全角空格编号', '状态': '新建', '发现发布': 'V1.0', '当前责任人': '张伟' },
    row('B2')
  ];
  const r = E.applyImport(s, rows, '2026-08-14T06:00:00');
  assert.strictEqual(r.imported, 2);
  assert.ok(s.bugs['B1']);                 // 清洗后正常导入
  assert.strictEqual(r.cleanedIds.length, 1);
  assert.strictEqual(r.cleanedIds[0].to, 'B1');
});

// ---------- 编号模糊筛选 ----------
test('编号筛选：支持模糊匹配（包含即命中）', () => {  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('BUG20260813656701', { '标题': 'A' }),
    row('BUG20260813656425', { '标题': 'B' }),
    row('BUG20260812655565', { '标题': 'C' }),
    row('BUG20260805649556', { '标题': 'D' })
  ], '2026-08-14T06:00:00');
  const recs = Object.keys(s.bugs).map((id) => s.bugs[id]);
  // 输入 56701 → 精确片段命中 1 个
  let out = E.filterRecords(recs, { '编号': { type: 'ids', value: ['56701'] } });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'BUG20260813656701');
  // 输入 20260813 → 模糊命中 2 个（前缀相同）
  out = E.filterRecords(recs, { '编号': { type: 'ids', value: ['20260813'] } });
  assert.strictEqual(out.length, 2);
  // 多个关键词任一匹配
  out = E.filterRecords(recs, { '编号': { type: 'ids', value: ['55565', '49556'] } });
  assert.strictEqual(out.length, 2);
  // 不区分大小写
  out = E.filterRecords(recs, { '编号': { type: 'ids', value: ['bug20260813656701'] } });
  assert.strictEqual(out.length, 1);
  // 无匹配
  out = E.filterRecords(recs, { '编号': { type: 'ids', value: ['NOPE'] } });
  assert.strictEqual(out.length, 0);
});

// ---------- 版本-姓名 分组导出 ----------
test('buildVerOwnerListText：按人员维度（组内版本有序）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V2.0', '当前责任人': '张伟' }),
    row('B2', { '发现发布': 'V1.0', '当前责任人': '张伟' }),
    row('B3', { '发现发布': 'V1.0', '当前责任人': '李娜' }),
    row('B4', { '发现发布': 'V1.0', '当前责任人': '张伟' })
  ], '2026-08-14T06:00:00');
  const recs = Object.keys(s.bugs).map((id) => s.bugs[id]);
  const text = E.buildVerOwnerListText(recs, 'owner');
  const lines = text.split('\n').filter(Boolean);
  // 张伟 组在前（zh 排序 李<张），组内 V1.0 在 V2.0 前
  assert.strictEqual(lines[0], 'V1.0-李娜（1）');
  assert.strictEqual(lines[1], 'B3');
  assert.strictEqual(lines[2], 'V1.0-张伟（2）');
  assert.ok(lines.slice(2, 5).indexOf('B2') !== -1 && lines.slice(2, 5).indexOf('B4') !== -1);
  assert.strictEqual(lines[5], 'V2.0-张伟（1）');
  assert.strictEqual(lines[6], 'B1');
});

test('buildVerOwnerListText：按版本维度（组内姓名有序）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [
    row('B1', { '发现发布': 'V2.0', '当前责任人': '张伟' }),
    row('B2', { '发现发布': 'V1.0', '当前责任人': '张伟' }),
    row('B3', { '发现发布': 'V1.0', '当前责任人': '李娜' })
  ], '2026-08-14T06:00:00');
  const recs = Object.keys(s.bugs).map((id) => s.bugs[id]);
  const text = E.buildVerOwnerListText(recs, 'version');
  const lines = text.split('\n').filter(Boolean);
  assert.strictEqual(lines[0], 'V1.0-李娜（1）');
  assert.strictEqual(lines[1], 'B3');
  assert.strictEqual(lines[2], 'V1.0-张伟（1）');
  assert.strictEqual(lines[4], 'V2.0-张伟（1）');
});

// ---------- v1.35.1：今日新增/今日解决 = 当天多次导入累计 ----------
test('todayStats：同一天两次导入，今日新增/解决为两次累计之和', () => {
  const s = E.emptyState('1.0.0');
  // 08-12 09:00 首次导入（基线：B1、B2 新增）
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-12T09:00:00');
  // 08-12 15:00 第二次导入：B1 消失（解决），新增 B3
  E.applyImport(s, [row('B2'), row('B3')], '2026-08-12T15:00:00');
  const t = E.todayStats(s, new Date('2026-08-12T20:00:00'));
  assert.strictEqual(t.imported, 3, '今日新增 = 两次导入新增之和（2+1）');
  assert.strictEqual(t.solved, 1, '今日解决 = 两次导入解决之和（0+1）');
  // 昨日视角（08-11）：无快照 → 0
  const tPrev = E.todayStats(s, new Date('2026-08-11T20:00:00'));
  assert.strictEqual(tPrev.imported, 0);
  assert.strictEqual(tPrev.solved, 0);
});

test('todayStats：跨天多次导入互不累计（各算各的）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-13T09:00:00');   // 08-13 新增 B2
  E.applyImport(s, [row('B2')], '2026-08-13T18:00:00');              // 08-13 解决 B1
  const d12 = E.todayStats(s, new Date('2026-08-12T20:00:00'));
  assert.strictEqual(d12.imported, 1, '08-12 只算当天新增');
  assert.strictEqual(d12.solved, 0);
  const d13 = E.todayStats(s, new Date('2026-08-13T20:00:00'));
  assert.strictEqual(d13.imported, 1, '08-13 新增只有 B2（B1 已存在不算）');
  assert.strictEqual(d13.solved, 1, '08-13 解决 B1');
});

test('todayStats：版本筛选口径（byVersion 累计 + dayAdj）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1', { '发现发布': 'V1.0' }), row('B2', { '发现发布': 'V2.0' })], '2026-08-12T09:00:00');
  E.applyImport(s, [row('B3', { '发现发布': 'V1.0' })], '2026-08-12T15:00:00');
  const t1 = E.todayStats(s, new Date('2026-08-12T20:00:00'), 'V1.0');
  assert.strictEqual(t1.imported, 2, 'V1.0 今日新增 = 2');
  const t2 = E.todayStats(s, new Date('2026-08-12T20:00:00'), 'V2.0');
  assert.strictEqual(t2.imported, 1, 'V2.0 今日新增 = 1');
  const tAll = E.todayStats(s, new Date('2026-08-12T20:00:00'));
  assert.strictEqual(tAll.imported, 3, '全部版本 = 3');
});

test('prevDayStats：今日累计 vs 上一导入日累计（delta 对比基准）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1'), row('B2')], '2026-08-11T09:00:00');    // 08-11 新增 2
  E.applyImport(s, [row('B2'), row('B3')], '2026-08-12T09:00:00');    // 08-12 新增 B3，解决 B1
  const prev = E.prevDayStats(s, new Date('2026-08-12T20:00:00'));
  assert.ok(prev, '应找到上一导入日 08-11');
  assert.strictEqual(prev.dayKey, '2026-08-11');
  assert.strictEqual(prev.imported, 2, '上一导入日新增 = 2');
  const t = E.todayStats(s, new Date('2026-08-12T20:00:00'));
  assert.strictEqual(t.imported - prev.imported, -1, '今日新增较昨日 -1');
  assert.strictEqual(t.solved - prev.solved, 1, '今日解决较昨日 +1');
  // 无更早快照（首次导入日）→ null
  assert.strictEqual(E.prevDayStats(s, new Date('2026-08-11T20:00:00')), null);
});

test('updateStatus：当天无快照时手动关闭计入 dayAdj（今日解决 +1，不污染跨天快照）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-11T09:00:00');   // 昨天导入
  // 今天（08-12）未导入，手动关闭 B1
  const r = E.updateStatus(s, 'B1', '关闭', '2026-08-12T10:00:00', 'jim');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.snapshots[0].solved, 0, '昨天快照不应被污染');
  assert.strictEqual(s.dayAdj['2026-08-12']['V1.0'], 1, 'dayAdj 记录当天手动关闭');
  const t = E.todayStats(s, new Date('2026-08-12T20:00:00'));
  assert.strictEqual(t.solved, 1, '今日解决 = 1（手动关闭）');
  // 重新打开 → -1
  E.updateStatus(s, 'B1', '处理中', '2026-08-12T11:00:00', 'jim');
  assert.strictEqual(s.dayAdj['2026-08-12']['V1.0'], 0, '重新打开后 dayAdj 归零');
  assert.strictEqual(E.todayStats(s, new Date('2026-08-12T20:00:00')).solved, 0);
});

test('updateStatus：当天有快照时手动关闭计入当天快照（今日累计口径）', () => {
  const s = E.emptyState('1.0.0');
  E.applyImport(s, [row('B1')], '2026-08-12T09:00:00');
  E.updateStatus(s, 'B1', '关闭', '2026-08-12T10:00:00', 'jim');
  assert.strictEqual(s.snapshots[0].solved, 1, '当天快照 solved +1');
  assert.strictEqual(E.todayStats(s, new Date('2026-08-12T20:00:00')).solved, 1);
});

console.log(`\n结果：${passed} 通过, ${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
