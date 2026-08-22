/**
 * engine.js — BUG 跟踪工具核心引擎（纯逻辑，无 DOM 依赖，可单元测试）
 *
 * 职责：
 *  1. 快照对比：新增 / 解决（消失即解决）/ 持续未解决 / 重新激活
 *  2. 导入应用：责任人覆盖 + 上次负责人记录 + 变更历史
 *  3. 统计计算：版本分布 / 严重程度分布 / 责任人维度 / 超期判定
 *  4. CSV 编码检测（UTF-8 / GBK）
 *
 * 数据模型（state）：
 * {
 *   appVersion: '1.0.0',
 *   people: ['张伟', ...],
 *   bugs: { [id]: BugRecord },
 *   history: [OwnerChange],
 *   snapshots: [SnapshotSummary]
 * }
 *
 * BugRecord:
 * {
 *   id, fields: { 标题, 描述, 状态, 发现发布, 分析原因, 停留天数, 严重程度,
 *                 当前责任人, 最近修改时间, 创建人, 退回原因, 激活原因, 最近更新人 },
 *   sys: {
 *     firstSeenAt,        // 首次发现（ISO 字符串）
 *     lastSolvedAt,       // 最后解决时间（null=未解决）
 *     reactivatedAt,      // 最近重新激活时间（null=无）
 *     prevOwner,          // 上次责任人（当前责任人的上一个值）
 *     lastImportedAt,     // 最近导入时间
 *     manualReassigned,   // 是否曾手动改派
 *   }
 * }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BugEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIELD_KEYS = [
    '标题', '描述', '编号', '严重程度', '当前责任人', '状态', '发现发布', '分析原因', '停留天数',
    '最近修改时间', '创建人', '退回原因', '激活原因', '最近更新人'
  ];

  /** 原始负责人名单（名单内人员的问题默认视为未分配状态，重新导入不覆盖已分配的责任人） */
  const DEFAULT_ORIGINAL_OWNERS = ['唐朝汉', '王东鸿', '詹泉宏', '胡宁', '熊乘风'];

  /** 同编号 BUG 已存在时，不随导入更新的字段（保留系统现有值）：
   *  v1.23.0 起「发现发布」移除保护——以最新导入版本号为准同步更新（导入结果罗列变更编号）
   *  v1.33.1 起「严重程度」移除保护——严重程度可能被重新评估，以最新导入为准
   *  v1.41.0 起「标题」移除保护——标题可能被修正，以最新导入为准（变更进导入历史明细） */
  const NO_UPDATE_FIELDS = ['描述', '创建人'];
  function makeOwnerChange(id, from, to, at, source) {
    return { id: String(id), from: from || '', to: to || '', at, source };
  }

  /** 空 BugRecord 工厂 */
  function emptyRecord(id) {
    const fields = {};
    FIELD_KEYS.forEach((k) => { fields[k] = ''; });
    return {
      id: String(id),
      fields,
      sys: {
        firstSeenAt: null, lastSolvedAt: null, reactivatedAt: null,
        prevOwner: '', originalOwner: '', lastImportedAt: null, manualReassigned: false,
        note: null   // { text, at, user } 单条备注（独立于导入数据，导入不覆盖）
      }
    };
  }

  /**
   * 编号清洗：去除全角空格/不间断空格/换行/制表符/零宽字符，防止
   * Excel 导出工具带入隐藏字符导致「单号看起来一样但匹配不上」的静默丢失
   */
  function cleanId(raw) {
    return String(raw == null ? '' : raw)
      .replace(/[\u3000\u00A0]/g, ' ')            // 全角空格/不间断空格 → 半角
      .replace(/[\r\n\t]+/g, '')                  // 去换行/制表符
      .replace(/[\u200B-\u200D\uFEFF]/g, '')      // 去零宽字符/BOM
      .trim();
  }

  /** 规范化单行导入数据 → { id, fields }；缺编号返回 null */
  function normalizeRow(rawRow, nowIso) {
    const id = cleanId(rawRow['编号']);
    if (!id) return null;
    const rec = emptyRecord(id);
    FIELD_KEYS.forEach((k) => {
      if (k === '编号') return;
      let v = rawRow[k];
      if (v == null) v = '';
      rec.fields[k] = String(v).trim();
    });
    rec.fields['编号'] = id;
    rec.sys.lastImportedAt = nowIso;
    return rec;
  }

  /** 责任人字段解析：支持 "原始/实际" 格式（如 唐朝汉/曾卓彬） */
  function parseOwnerField(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { owner: '未分配', originalOwner: '' };
    if (s.indexOf('/') !== -1) {
      const parts = s.split('/').map((p) => p.trim()).filter(Boolean);
      return { owner: parts[parts.length - 1], originalOwner: parts[0] };
    }
    return { owner: s, originalOwner: s };
  }

  /** 提取责任人（空值 → '未分配'） */
  function ownerOf(rec) {
    const o = (rec.fields['当前责任人'] || '').trim();
    return o || '未分配';
  }

  /** 是否为活跃（未解决）状态：lastSolvedAt 为空，或最近重新激活晚于解决；手动「关闭」的 BUG 视为不活跃 */
  function isActive(rec) {
    if (rec.sys.manualClosedAt) return false;
    if (!rec.sys.lastSolvedAt) return true;
    if (rec.sys.reactivatedAt && rec.sys.reactivatedAt > rec.sys.lastSolvedAt) return true;
    return false;
  }

  /** 快照摘要（含版本维度明细，用于看板按版本筛选趋势） */
  function snapshotSummary(at, imported, solved, reactivated, totalActive, byVersion, versionCounts) {
    return { at, imported, solved, reactivated, totalActive, byVersion: byVersion || {}, versionCounts: versionCounts || {} };
  }

  /**
   * 应用一次导入（核心流程）
   * @param {object} state 当前状态（会被修改）
   * @param {Array<object>} rows 导入的原始行（含 编号 等字段）
   * @param {string} nowIso 导入时间 ISO 字符串
   * @returns {{imported:number, solved:number, reactivated:number, ownerChanges:number, warnings:string[]}}
   */
  function applyImport(state, rows, nowIso) {
    if (!state.bugs) state.bugs = {};
    if (!state.history) state.history = [];
    if (!state.snapshots) state.snapshots = [];
    if (!state.people) state.people = [];

    const warnings = [];

    // 1. 规范化 + 去重（同次导入同编号取最后一行）
    // 同时统计：缺编号行（清洗后为空，含全角空格/隐藏字符）与编号被清洗的行
    const byId = {};
    const skippedRows = [];   // 缺编号未导入的行 { row: 文件行号, hint: 标题片段 }
    const cleanedIds = [];    // 编号含隐藏字符被清洗 { from, to }
    rows.forEach((r, idx) => {
      const rawId = r['编号'];
      const cleaned = cleanId(rawId);
      if (!cleaned) {
        const hint = String(r['标题'] || r['描述'] || '').slice(0, 30);
        skippedRows.push({ row: idx + 2, hint });   // +2：表头占 1 行，数据从第 2 行起
        return;
      }
      if (String(rawId == null ? '' : rawId) !== cleaned) {
        cleanedIds.push({ from: String(rawId).trim(), to: cleaned });
      }
      const rec = normalizeRow(r, nowIso);
      if (!rec) return;
      // 责任人字段解析：唐朝汉/曾卓彬 → 实际责任人=曾卓彬，原始负责人=唐朝汉
      const parsed = parseOwnerField(rec.fields['当前责任人']);
      rec.fields['当前责任人'] = parsed.owner;
      rec.sys.originalOwner = parsed.originalOwner;
      byId[rec.id] = rec;   // 同编号取最后一行（真正去重）
    });
    const incoming = Object.keys(byId).map((id) => byId[id]);
    const rawCount = rows.length;   // 原始行数（含同批重复）

    // 2. 对比上次快照：识别消失（解决）与新增
    // 范围推断（版本匹配）：仅「版本 ∈ 本次导入版本集合」的活跃 BUG 参与消失判定，
    // 本次未出现才判定为已解决 —— 按版本/全量导入精确；范围外版本（如存量导入未覆盖的版本）一律不动
    const inVersions = new Set(incoming.map((r) => (r.fields['发现发布'] || '').trim() || '未标注'));
    const prevIds = new Set(
      Object.keys(state.bugs).filter((id) => {
        const rec = state.bugs[id];
        if (!isActive(rec)) return false;
        const v = (rec.fields['发现发布'] || '').trim() || '未标注';
        return inVersions.has(v);
      })
    );
    const curIds = new Set(incoming.map((r) => r.id));

    let solvedCount = 0;
    const solvedIds = [];
    const versionChanges = [];   // 版本变更：{id, from, to}（以最新导入版本号为准）
    const byVersion = {};   // { 版本: {imported, solved} }
    const bumpVersion = (ver, key) => {
      const v = ver || '未标注';
      if (!byVersion[v]) byVersion[v] = { imported: 0, solved: 0 };
      byVersion[v][key]++;
    };
    prevIds.forEach((id) => {
      if (!curIds.has(id)) {
        const rec = state.bugs[id];
        rec.sys.lastSolvedAt = nowIso;
        solvedCount++;
        solvedIds.push(id);
        bumpVersion(rec.fields['发现发布'], 'solved');
      }
    });

    // 3. 漏导防护：解决数异常（> 存量 30%）告警（由调用方决定是否强制确认）
    if (prevIds.size > 0 && solvedCount > Math.ceil(prevIds.size * 0.3)) {
      warnings.push(`本次对比出 ${solvedCount} 个 BUG 消失（存量 ${prevIds.size}），疑似漏导或列表不完整，请确认`);
    }

    // 4. 应用/更新每条记录
    let importedCount = 0;
    let reactivatedCount = 0;
    let ownerChanges = 0;
    let ownerSkipped = 0;   // 原始负责人保护跳过的次数

    incoming.forEach((inc) => {
      const existed = state.bugs[inc.id];
      if (!existed) {
        // 全新 BUG
        inc.sys.firstSeenAt = nowIso;
        state.bugs[inc.id] = inc;
        importedCount++;
        bumpVersion(inc.fields['发现发布'], 'imported');
        // 人员名单自动补全
        const o = ownerOf(inc);
        if (o !== '未分配' && state.people.indexOf(o) === -1) {
          state.people.push(o);
        }
        return;
      }
      // 已存在：更新字段
      const rec = existed;
      const prevOwner = ownerOf(rec);
      const newOwner = ownerOf(inc);
      const wasSolved = !isActive(rec);

      // 原始负责人保护：导入责任人是白名单（无斜杠）且与系统当前责任人不同，
      // 说明该问题已分配给其他人 → 不更新责任人，其他字段照常更新
      // 兜底：历史字段判定（rec.sys.originalOwner 与导入原始负责人一致时同样保护）
      const recOriginal = rec.sys.originalOwner || '';
      const incOriginal = inc.sys.originalOwner || '';
      const originalOwners = Array.isArray(state.originalOwners) ? state.originalOwners : [];
      const inOriginalList = (name) => originalOwners.indexOf(name) !== -1;
      const isProtected = (
        // ① 名单判定：导入=白名单人员，且与系统当前责任人不同 → 已分配出去，不覆盖
        (inOriginalList(newOwner) && prevOwner !== newOwner) ||
        // ② 历史字段兜底
        (recOriginal && incOriginal === recOriginal && prevOwner !== recOriginal && newOwner === recOriginal)
      );
      if (isProtected) {
        // 保留当前责任人，不覆盖（其他字段仍会更新）
        inc.fields['当前责任人'] = prevOwner;
        ownerSkipped++;
      }

      // 责任人变更（导入覆盖 + 记录上次负责人；保护跳过的不算变更）
      // v1.24.0：与字段变更明细合并为一条记录（from/to 表达责任人，changes 表达其他字段）
      let ownerChangeRec = null;
      if (prevOwner !== newOwner && !isProtected) {
        rec.sys.prevOwner = prevOwner;
        ownerChanges++;
        ownerChangeRec = { from: prevOwner, to: newOwner };
      }
      // 重新激活：曾解决（或曾消失）又出现；手动「关闭」的 BUG 不自动重新激活（保持关闭直到手动改回）
      if (!rec.sys.manualClosedAt && (wasSolved || (rec.sys.lastSolvedAt && rec.sys.lastSolvedAt <= nowIso))) {
        rec.sys.reactivatedAt = nowIso;
        // 重新激活后 lastSolvedAt 保留（用于统计"曾解决"），活跃判定由 reactivatedAt 覆盖
        reactivatedCount++;
      }
      // 版本变更检测（v1.23.0）：以最新导入版本号为准，同步更新并罗列变更编号
      const oldVer = (rec.fields['发现发布'] || '').trim() || '未标注';
      const newVer = (inc.fields['发现发布'] || '').trim() || '未标注';
      if (newVer !== oldVer) {
        versionChanges.push({ id: inc.id, from: oldVer, to: newVer });
      }
      // 导入字段变更明细（v1.24.0）：覆盖前收集——rec.fields 仍为旧值，对比出本次变化字段
      const fieldChanges = [];
      FIELD_KEYS.forEach((k) => {
        if (k === '编号' || k === '当前责任人') return;
        if (NO_UPDATE_FIELDS.indexOf(k) !== -1) return;
        // 手动「关闭」的 BUG：状态列不随导入覆盖（保持「关闭」直到手动改回）
        if (k === '状态' && rec.sys.manualClosedAt) return;
        const oldV = String(rec.fields[k] == null ? '' : rec.fields[k]);
        const newV = String(inc.fields[k] == null ? '' : inc.fields[k]);
        if (oldV !== newV) fieldChanges.push({ field: k, from: oldV, to: newV });
      });
      // 覆盖字段：同编号已存在的 BUG 只更新动态字段，静态字段（描述/创建人）保留系统现有值（v1.41.0 起标题随导入更新）
      FIELD_KEYS.forEach((k) => {
        if (k === '编号' || k === '当前责任人') return;
        if (NO_UPDATE_FIELDS.indexOf(k) !== -1) return;
        if (k === '状态' && rec.sys.manualClosedAt) return;
        rec.fields[k] = inc.fields[k];
      });
      // 责任人显式赋值（incoming 已处理：斜杠解析 / 保护跳过保留 prevOwner）
      rec.fields['当前责任人'] = inc.fields['当前责任人'];
      if (incOriginal) rec.sys.originalOwner = incOriginal;
      rec.sys.lastImportedAt = nowIso;
      // 导入变更历史（v1.24.0）：责任人变更（from/to）+ 字段明细（changes）合并为一条记录
      if (ownerChangeRec || fieldChanges.length) {
        const rec_hist = { id: inc.id, from: '', to: '', at: nowIso, source: 'import' };
        if (ownerChangeRec) { rec_hist.from = ownerChangeRec.from; rec_hist.to = ownerChangeRec.to; }
        if (fieldChanges.length) rec_hist.changes = fieldChanges;
        state.history.push(rec_hist);
      }
      // 人员名单自动补全
      if (newOwner !== '未分配' && state.people.indexOf(newOwner) === -1) {
        state.people.push(newOwner);
      }
    });

    // 5. 快照记录
    const totalActive = Object.keys(state.bugs).filter((id) => isActive(state.bugs[id])).length;
    // 本次导入的版本分布（去重后所有行，含已存在/已解决状态行）——「按发现发布统计」数据源
    const versionCounts = {};
    incoming.forEach((inc) => {
      const v = (inc.fields['发现发布'] || '').trim() || '未标注';
      versionCounts[v] = (versionCounts[v] || 0) + 1;
    });
    state.snapshots.push(snapshotSummary(nowIso, importedCount, solvedCount, reactivatedCount, totalActive, byVersion, versionCounts));

    return {
      totalCount: incoming.length,          // 本次导入去重后总条数
      rawCount,                             // 原始行数（含同批重复编号）
      existingCount: incoming.length - importedCount,  // 已存在（编号重复）条数
      imported: importedCount,
      solved: solvedCount,
      reactivated: reactivatedCount,
      ownerChanges,
      ownerSkipped,
      versionChanges,                       // 版本变更清单 [{id, from, to}]
      solvedIds,
      skippedRows,                          // 缺编号未导入的行 [{row, hint}]
      cleanedIds,                           // 编号含隐藏字符被清洗 [{from, to}]
      warnings
    };
  }

  /** 手动修改 BUG 的「发现发布」版本（v1.23.0）：写入变更历史（source='verchange'） */
  function updateVersion(state, id, newVer, nowIso, user) {
    const rec = state.bugs[id];
    if (!rec) return { ok: false, error: 'BUG 不存在' };
    const v = String(newVer == null ? '' : newVer).trim();
    if (!v) return { ok: false, error: '版本不能为空' };
    const old = (rec.fields['发现发布'] || '').trim() || '未标注';
    if (v === old) return { ok: true, changed: false };
    rec.fields['发现发布'] = v;
    state.history.push({ id: String(id), from: old, to: v, at: nowIso, source: 'verchange', user: user || '' });
    return { ok: true, changed: true };
  }

  /** 手动修改状态（v1.32.0）：设为「关闭」→ 标记 manualClosedAt（不活跃，看板全联动，导入不覆盖）；
   *  改为其他状态 → 清除标记恢复活跃。写变更历史可追溯 */
  function updateStatus(state, id, newStatus, nowIso, user) {
    const rec = state.bugs[id];
    if (!rec) return { ok: false, error: 'BUG 不存在' };
    const v = String(newStatus == null ? '' : newStatus).trim();
    if (!v) return { ok: false, error: '状态不能为空' };
    const old = rec.sys.manualClosedAt ? '关闭' : (String(rec.fields['状态'] || '').trim() || '—');
    if (v === old) return { ok: true, changed: false };
    rec.fields['状态'] = v;
    if (v === '关闭') {
      rec.sys.manualClosedAt = nowIso;
    } else {
      rec.sys.manualClosedAt = null;
    }
    // 手动关闭/重新打开联动「操作当天」的 solved 计数（v1.35.1：今日解决 = 当天累计口径）
    // 当天有快照 → 更新当天最后一条快照；当天无快照 → 记入 state.dayAdj（不污染跨天快照）
    const dayKey = String(nowIso).slice(0, 10);
    const snaps = state.snapshots || [];
    const delta = v === '关闭' ? 1 : -1;
    const ver = (rec.fields['发现发布'] || '').trim() || '未标注';
    let daySnap = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (String(snaps[i].at).slice(0, 10) === dayKey) { daySnap = snaps[i]; break; }
    }
    if (daySnap) {
      daySnap.solved = Math.max(0, (daySnap.solved || 0) + delta);
      const bv = daySnap.byVersion || {};
      if (bv[ver]) {
        bv[ver].solved = Math.max(0, (bv[ver].solved || 0) + delta);
      } else if (delta > 0) {
        bv[ver] = { imported: 0, solved: 1 };
      }
    } else {
      if (!state.dayAdj) state.dayAdj = {};
      if (!state.dayAdj[dayKey]) state.dayAdj[dayKey] = {};
      state.dayAdj[dayKey][ver] = Math.max(0, (state.dayAdj[dayKey][ver] || 0) + delta);
    }
    state.history.push({ id: String(id), from: old, to: v, at: nowIso, source: 'statuschange', user: user || '' });
    return { ok: true, changed: true };
  }

  /** 手动改派责任人 */
  function reassign(state, id, newOwner, nowIso, people) {
    const rec = state.bugs[id];
    if (!rec) return { ok: false, error: 'BUG 不存在' };
    if (!people || people.indexOf(newOwner) === -1) {
      return { ok: false, error: '责任人不在人员名单中' };
    }
    const prev = ownerOf(rec);
    if (prev === newOwner) return { ok: true, changed: false };
    rec.sys.prevOwner = prev;
    rec.fields['当前责任人'] = newOwner;
    rec.sys.manualReassigned = true;
    state.history.push(makeOwnerChange(id, prev, newOwner, nowIso, 'manual'));
    return { ok: true, changed: true };
  }

  /**
   * 设置/清除 BUG 备注（单条覆盖，独立于导入数据，导入不覆盖）
   * @param {object} state 当前状态（会被修改）
   * @param {string} id BUG 编号
   * @param {string} text 备注内容（空字符串 = 清除备注）
   * @param {string} user 操作人
   * @param {string} nowIso 操作时间 ISO 字符串
   * @returns {{ok:boolean, error?:string, cleared?:boolean}}
   */
  function setNote(state, id, text, user, nowIso) {
    const rec = state.bugs[id];
    if (!rec) return { ok: false, error: 'BUG 不存在' };
    const t = String(text == null ? '' : text).trim();
    if (!t) {
      // 空内容 = 清除备注
      rec.sys.note = null;
      return { ok: true, cleared: true };
    }
    rec.sys.note = { text: t, at: nowIso, user: user || '' };
    return { ok: true, cleared: false };
  }

  /**
   * 删除一条 BUG：从列表移除 + 写入变更历史（source='delete'，含原因/操作人），
   * 并同步修正最近快照统计（totalActive / versionCounts），保证所有看板卡片同步减少
   * @param {object} state 当前状态（会被修改）
   * @param {string} id BUG 编号
   * @param {string} reason 删除原因（必填）
   * @param {string} user 操作人
   * @param {string} nowIso 操作时间 ISO 字符串
   * @returns {{ok:boolean, error?:string}}
   */
  function removeBug(state, id, reason, user, nowIso) {
    const rec = state.bugs[id];
    if (!rec) return { ok: false, error: 'BUG 不存在' };
    const r = String(reason == null ? '' : reason).trim();
    if (!r) return { ok: false, error: '请填写删除原因' };
    const title = rec.fields['标题'] || '';
    const ver = (rec.fields['发现发布'] || '').trim() || '未标注';
    const wasActive = isActive(rec);
    // 历史留痕（删除记录）
    state.history.push({
      id: String(id), from: '', to: '', at: nowIso, source: 'delete',
      reason: r, user: user || '', title
    });
    delete state.bugs[id];
    // 同步修正最近快照：未解决总数 / 版本分布，保证看板卡片同步减少
    const snaps = state.snapshots || [];
    const last = snaps.length ? snaps[snaps.length - 1] : null;
    if (last) {
      if (wasActive) last.totalActive = Math.max(0, (last.totalActive || 0) - 1);
      const vc = last.versionCounts;
      if (vc && vc[ver] != null) {
        vc[ver] = Math.max(0, vc[ver] - 1);
        if (vc[ver] === 0) delete vc[ver];
      }
    }
    return { ok: true };
  }

  /** 人员管理：新增 / 重命名 / 删除（有未解决 BUG 禁止删除） */
  function addPerson(state, name) {
    const n = String(name || '').trim();
    if (!n) return { ok: false, error: '姓名不能为空' };
    if (state.people.indexOf(n) !== -1) return { ok: false, error: '人员已存在' };
    state.people.push(n);
    return { ok: true };
  }

  function renamePerson(state, oldName, newName) {
    const n = String(newName || '').trim();
    if (!n) return { ok: false, error: '姓名不能为空' };
    const idx = state.people.indexOf(oldName);
    if (idx === -1) return { ok: false, error: '原人员不存在' };
    if (state.people.indexOf(n) !== -1 && n !== oldName) return { ok: false, error: '新姓名已存在' };
    // 更新 BUG 责任人 + 历史
    state.people[idx] = n;
    Object.keys(state.bugs).forEach((id) => {
      const rec = state.bugs[id];
      if (rec.fields['当前责任人'] === oldName) rec.fields['当前责任人'] = n;
      if (rec.sys.prevOwner === oldName) rec.sys.prevOwner = n;
    });
    state.history.forEach((h) => {
      if (h.from === oldName) h.from = n;
      if (h.to === oldName) h.to = n;
    });
    return { ok: true };
  }

  function removePerson(state, name) {
    const idx = state.people.indexOf(name);
    if (idx === -1) return { ok: false, error: '人员不存在' };
    const activeCount = Object.keys(state.bugs).filter((id) => {
      const rec = state.bugs[id];
      return isActive(rec) && ownerOf(rec) === name;
    }).length;
    if (activeCount > 0) {
      return { ok: false, error: `该人名下还有 ${activeCount} 个未解决 BUG，请先改派` };
    }
    state.people.splice(idx, 1);
    return { ok: true };
  }

  /**
   * 统计：未解决总数 / 版本分布 / 严重程度分布 / 超期数
   * version 传字符串 = 单版本过滤；传数组 = 多版本过滤（任一匹配）；空 = 全部
   */
  function computeStats(state, overdueDays, version) {
    const threshold = overdueDays == null ? 5 : Number(overdueDays);
    const bugs = state.bugs || {};
    const verList = Array.isArray(version) ? version : (version ? [version] : []);
    const active = Object.keys(bugs).map((id) => bugs[id]).filter((rec) => {
      if (!isActive(rec)) return false;
      if (verList.length) {
        const v = (rec.fields['发现发布'] || '').trim();
        if (verList.indexOf(v) === -1) return false;
      }
      return true;
    });

    const totalActive = active.length;
    let overdue = 0;
    const versionMap = {};   // 发现发布 → 数量
    const severityMap = {};  // 严重程度 → 数量
    const ownerMap = {};     // 责任人 → { active, overdue }

    active.forEach((rec) => {
      const ver = (rec.fields['发现发布'] || '').trim() || '未标注';
      versionMap[ver] = (versionMap[ver] || 0) + 1;

      const sev = (rec.fields['严重程度'] || '').trim() || '未标注';
      severityMap[sev] = (severityMap[sev] || 0) + 1;

      const owner = ownerOf(rec);
      if (!ownerMap[owner]) ownerMap[owner] = { active: 0, overdue: 0 };
      ownerMap[owner].active++;

      const days = parseInt(rec.fields['停留天数'], 10);
      if (!isNaN(days) && days >= threshold) {
        overdue++;
        ownerMap[owner].overdue++;
      }
    });

    return {
      totalActive,
      overdue,
      overdueThreshold: threshold,
      byVersion: versionMap,
      bySeverity: severityMap,
      byOwner: ownerMap
    };
  }

  /**
   * 版本号比较：a < b 返回 true（支持 x.y.z）
   */
  function versionLessThan(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  /**
   * 存量数据迁移：升级后补齐旧数据缺口，保证新逻辑展示正确
   * 幂等：重复执行不产生副作用；无缺口时原样返回
   * @param {object} state 当前状态（会被原地修改）
   * @param {string} targetVersion 目标版本号
   * @returns {{state:object, changed:boolean}} changed=true 表示发生了迁移（需保存）
   */
  function migrateState(state, targetVersion) {
    const from = state.appVersion || '0';
    let changed = false;
    const snapshots = state.snapshots || [];

    // v1.9.1+：「按发现发布统计」依赖快照 versionCounts（最近一次导入的版本分布）
    // 旧快照无此字段 → 以当前 bugs 全量版本分布兜底补齐，下次导入后自动精确
    if (versionLessThan(from, '1.9.1') && snapshots.length) {
      const last = snapshots[snapshots.length - 1];
      if (!last.versionCounts || !Object.keys(last.versionCounts).length) {
        const bugs = state.bugs || {};
        const vc = {};
        Object.keys(bugs).forEach((id) => {
          const v = (bugs[id].fields['发现发布'] || '').trim() || '未标注';
          vc[v] = (vc[v] || 0) + 1;
        });
        last.versionCounts = vc;
        last.vcFallback = true;   // 标记为迁移兜底值（非真实导入），下次导入后自动替换
        changed = true;
      }
    }

    if (changed) state.appVersion = targetVersion;
    return { state, changed };
  }

  /**
   * 撤销一次导入的「消失=已解决」判定：将指定编号的 BUG 恢复为活跃（未解决），
   * 并同步修正最近快照的 solved 计数（含版本明细），保证统计一致
   * @param {object} state 当前状态（会被修改）
   * @param {string[]} ids 要恢复的 BUG 编号
   * @returns {number} 实际恢复的数量
   */
  function undoSolved(state, ids) {
    if (!ids || !ids.length) return 0;
    const snaps = state.snapshots || [];
    const last = snaps.length ? snaps[snaps.length - 1] : null;
    const restoredIds = [];
    ids.forEach((id) => {
      const rec = state.bugs[id];
      if (!rec) return;
      const wasActive = isActive(rec);
      rec.sys.lastSolvedAt = null;
      rec.sys.reactivatedAt = null;
      if (!wasActive) restoredIds.push(id);
    });
    // 修正最近快照的 solved 计数（含版本明细）
    if (last && restoredIds.length) {
      last.solved = Math.max(0, (last.solved || 0) - restoredIds.length);
      const bv = last.byVersion || {};
      restoredIds.forEach((id) => {
        const rec = state.bugs[id];
        if (!rec) return;
        const v = (rec.fields['发现发布'] || '').trim() || '未标注';
        if (bv[v] && bv[v].solved) bv[v].solved = Math.max(0, bv[v].solved - 1);
      });
    }
    return restoredIds.length;
  }

  /**
   * 全量版本分布（含已解决），与版本筛选下拉口径一致
   * @returns {{byVersion:Object<string,number>, byActive:Object<string,number>}}
   *   byVersion = 版本 → 全部 BUG 数；byActive = 版本 → 未解决 BUG 数
   */
  function computeAllVersionStats(state) {
    const bugs = state.bugs || {};
    const byVersion = {};
    const byActive = {};
    Object.keys(bugs).forEach((id) => {
      const rec = bugs[id];
      const ver = (rec.fields['发现发布'] || '').trim() || '未标注';
      byVersion[ver] = (byVersion[ver] || 0) + 1;
      if (isActive(rec)) byActive[ver] = (byActive[ver] || 0) + 1;
    });
    return { byVersion, byActive };
  }

  /** 最近一次快照（今日新增/解决数据源） */
  function lastSnapshot(state) {
    const snaps = state.snapshots || [];
    return snaps.length ? snaps[snaps.length - 1] : null;
  }

  /** 日期 key（YYYY-MM-DD）：now 支持 Date / ISO 字符串 */
  function dayKeyOf(now) {
    if (typeof now === 'string') return String(now).slice(0, 10);
    const d = now instanceof Date ? now : new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 指定日期累计统计（v1.35.1）：该日所有导入快照的 imported/solved 之和 + 该日手动关闭调整；
   *  与 trend7 口径一致（趋势图本就按天累计）。version 传字符串或数组时只统计对应版本 */
  function sumDayStats(state, dayKey, version) {
    const snaps = state.snapshots || [];
    const verList = Array.isArray(version) ? version : (version ? [version] : []);
    let imported = 0;
    let solved = 0;
    snaps.forEach((s) => {
      if (String(s.at).slice(0, 10) !== dayKey) return;
      if (verList.length) {
        const bv = s.byVersion || {};
        verList.forEach((v) => {
          if (bv[v]) { imported += bv[v].imported || 0; solved += bv[v].solved || 0; }
        });
      } else {
        imported += s.imported || 0;
        solved += s.solved || 0;
      }
    });
    // 当日手动关闭/重新打开调整（当天无快照时记录在 dayAdj；有快照时互斥，不会重复）
    const adj = (state.dayAdj && state.dayAdj[dayKey]) || {};
    if (verList.length) {
      verList.forEach((v) => { solved += adj[v] || 0; });
    } else {
      Object.keys(adj).forEach((v) => { solved += adj[v] || 0; });
    }
    return { imported, solved, dayKey };
  }

  /** 今日累计新增/解决（当天多次导入累加 + 手动关闭调整） */
  function todayStats(state, now, version) {
    return sumDayStats(state, dayKeyOf(now), version);
  }

  /** 上一导入日累计（用于「较昨日」对比）：今天之前最近一个有快照的日期的全天累计；
   *  无更早快照时返回 null（首次快照场景） */
  function prevDayStats(state, now, version) {
    const snaps = state.snapshots || [];
    const todayKey = dayKeyOf(now);
    let prevDay = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      const k = String(snaps[i].at).slice(0, 10);
      if (k < todayKey) { prevDay = k; break; }
    }
    if (!prevDay) return null;
    return sumDayStats(state, prevDay, version);
  }

  /** N 日趋势（从快照记录取，缺天显示无数据；version 传字符串或数组时只统计对应版本） */
  function trend7(state, now, days, version) {
    const snaps = state.snapshots || [];
    const n = Math.max(1, Math.min(90, parseInt(days, 10) || 7));
    const list = [];
    const d = new Date(now);
    const verList = Array.isArray(version) ? version : (version ? [version] : []);
    const inList = (v) => verList.length === 0 || verList.indexOf(v) !== -1;
    for (let i = n - 1; i >= 0; i--) {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      const daySnaps = snaps.filter((s) => s.at.slice(0, 10) === key);
      let imported = 0;
      let solved = 0;
      let hasData = false;
      daySnaps.forEach((s) => {
        if (verList.length) {
          const bv = s.byVersion || {};
          verList.forEach((v) => {
            if (bv[v]) { imported += bv[v].imported || 0; solved += bv[v].solved || 0; hasData = true; }
          });
        } else {
          imported += s.imported || 0;
          solved += s.solved || 0;
          hasData = true;
        }
      });
      list.push({
        date: key,
        label: `${day.getMonth() + 1}-${day.getDate()}`,
        imported,
        solved,
        hasData
      });
    }
    return list;
  }

  /**
   * 按月统计（v1.37.0）：按 BUG 编号建单日期归月（编号格式 BUGYYYYMMDDxxxxxx）
   * 口径与「累计问题」卡片一致：统计范围内全部 BUG（含已解决）
   * @param {Object} state 全局状态
   * @param {string|string[]} [version] 版本筛选（传字符串或数组；不传/空数组 = 全部版本）
   * @returns {Array<{month:string, label:string, total:number, fixed:number, active:number}>} 按月份升序
   */
  function monthStats(state, version) {
    const bugs = state.bugs || {};
    const verList = Array.isArray(version) ? version : (version ? [version] : []);
    const inList = (v) => verList.length === 0 || verList.indexOf(v) !== -1;
    const byMonth = {};
    Object.keys(bugs).forEach((id) => {
      const rec = bugs[id];
      if (!inList((rec.fields['发现发布'] || '').trim() || '未标注')) return;
      let month;
      const mm = /^BUG(\d{6})/.exec(String(rec.fields['编号'] || ''));
      if (mm) {
        month = mm[1]; // YYYYMM
      } else if (rec.sys && rec.sys.firstSeenAt) {
        // 编号异常兜底（v1.39.1）：按首次导入时间归月，保证按月总和与「累计问题」卡片一致
        month = String(rec.sys.firstSeenAt).replace(/\D/g, '').slice(0, 6);
      } else {
        return; // 编号异常且无导入时间：极少数，跳过
      }
      if (!byMonth[month]) byMonth[month] = { total: 0, fixed: 0 };
      byMonth[month].total += 1;
      if (!isActive(rec)) byMonth[month].fixed += 1;
    });
    return Object.keys(byMonth).sort().map((month) => {
      const d = byMonth[month];
      return {
        month,
        label: `${month.slice(0, 4)}-${month.slice(4)}`,
        total: d.total,
        fixed: d.fixed,
        active: d.total - d.fixed
      };
    });
  }

  /**
   * 编号异常 BUG 列表（v1.40.0）：编号不匹配完整格式 BUGYYYYMMDDxxxxxx（BUG+8位日期+序号）
   * @param {Object} state 全局状态
   * @returns {Array<{id:string, no:string, title:string, version:string, status:string, firstSeenAt:string}>}
   */
  function findAbnormalIds(state) {
    const bugs = state.bugs || {};
    const out = [];
    Object.keys(bugs).forEach((id) => {
      const rec = bugs[id];
      const no = String(rec.fields['编号'] || '').trim();
      if (!/^BUG\d{8}\d+$/.test(no)) {
        out.push({
          id,
          no: no || '（空）',
          title: rec.fields['标题'] || '',
          version: (rec.fields['发现发布'] || '').trim() || '未标注',
          status: rec.fields['状态'] || '',
          firstSeenAt: (rec.sys && rec.sys.firstSeenAt) || ''
        });
      }
    });
    return out;
  }

  /** CSV 编码检测：UTF-8（含 BOM）或 GBK */
  function detectCsvEncoding(bytes) {
    // BOM 检测
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return 'utf-8-bom';
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
    // 严格 UTF-8 校验：出现非法序列则判定 GBK
    let i = 0;
    const len = bytes.length;
    let suspicious = 0;
    while (i < len) {
      const b = bytes[i];
      if (b < 0x80) { i++; continue; }
      let n = 0;
      if (b >= 0xC2 && b <= 0xDF) n = 1;
      else if (b >= 0xE0 && b <= 0xEF) n = 2;
      else if (b >= 0xF0 && b <= 0xF4) n = 3;
      else { suspicious++; i++; continue; }
      if (i + n >= len) { suspicious++; break; }
      let ok = true;
      for (let j = 1; j <= n; j++) {
        const c = bytes[i + j];
        if (c < 0x80 || c > 0xBF) { ok = false; break; }
      }
      if (!ok) suspicious++;
      i += n + 1;
    }
    // 允许少量异常（如特殊符号），超过样本 1% 判 GBK
    const sample = Math.max(len, 1);
    return (suspicious / sample) > 0.01 ? 'gbk' : 'utf-8';
  }

  /** 按列筛选（动态全列） */
  function filterRecords(records, criteria) {
    // criteria: { colName: { type:'text'|'enum'|'number'|'date', value: ... } }
    return records.filter((rec) => {
      for (const col of Object.keys(criteria)) {
        const c = criteria[col];
        // 「当前责任人」按展示口径（ownerOf，空值→未分配）匹配，保证与列表显示/统计一致
        const raw = col === '当前责任人' ? ownerOf(rec) : (rec.fields[col] == null ? '' : String(rec.fields[col]));
        if (c.type === 'enum') {
          if (!c.value || c.value.length === 0) continue;
          if (c.value.indexOf(raw) === -1) return false;
        } else if (c.type === 'ids') {
          // 编号模糊匹配：任一关键词被 记录id 或 编号字段 包含即通过（不区分大小写）
          if (!c.value || c.value.length === 0) continue;
          const idLow = String(rec.id || '').toLowerCase();
          const rawLow = raw.toLowerCase();
          const hit = c.value.some((v) => {
            const kw = String(v).toLowerCase();
            return kw && (idLow.indexOf(kw) !== -1 || rawLow.indexOf(kw) !== -1);
          });
          if (!hit) return false;
        } else if (c.type === 'text') {
          if (!c.value) continue;
          if (raw.toLowerCase().indexOf(String(c.value).toLowerCase()) === -1) return false;
        } else if (c.type === 'number') {
          const n = parseFloat(raw);
          if (c.min != null && !isNaN(n) && n < c.min) return false;
          if (c.max != null && !isNaN(n) && n > c.max) return false;
        } else if (c.type === 'date') {
          const d = raw.slice(0, 10);
          if (c.from && d < c.from) return false;
          if (c.to && d > c.to) return false;
        } else if (col === '__todayNew') {
          // 今日新增：首次发现日期 = 今天（与看板「今日新增」卡片口径一致）
          const d = rec.sys && rec.sys.firstSeenAt ? String(rec.sys.firstSeenAt).slice(0, 10) : '';
          const n = new Date();
          const tk = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
          if (d !== tk) return false;
        }
      }
      return true;
    });
  }

  /** 空状态工厂 */
  function emptyState(appVersion) {
    return {
      appVersion: appVersion || '1.0.0',
      people: [],
      originalOwners: DEFAULT_ORIGINAL_OWNERS.slice(),
      bugs: {},
      history: [],
      snapshots: [],
      dayAdj: {}   // 当日手动关闭/重新打开调整：{ 'YYYY-MM-DD': { 版本: 净调整数 } }（当天无快照时记录，v1.35.1）
    };
  }

  /** 按当前责任人分组生成问题清单结构：[{owner, count, ids:[...]}]，按数量降序 */
  function buildOwnerBugList(records) {
    const groups = {};
    records.forEach((rec) => {
      const owner = ownerOf(rec);
      if (!groups[owner]) groups[owner] = [];
      groups[owner].push(rec.id);
    });
    return Object.keys(groups)
      .map((owner) => ({ owner, count: groups[owner].length, ids: groups[owner] }))
      .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner, 'zh'));
  }

  /** 生成问题清单文本（负责人分组格式） */
  function buildBugListText(records) {
    const groups = buildOwnerBugList(records);
    const lines = [];
    groups.forEach((g) => {
      lines.push(`${g.owner}（${g.count}）`);
      g.ids.forEach((id) => lines.push(id));
      lines.push('');
    });
    return lines.join('\n').replace(/\n+$/, '\n');
  }

  /**
   * 生成「版本-姓名」分组清单文本
   * 行格式：版本号-姓名（条数），下一行起为该组 BUG 编号
   * 维度：dim='owner' 按人员聚合（组内按版本排序）；dim='version' 按版本聚合（组内按姓名排序）
   * @param {Array<object>} records BUG 记录列表
   * @param {string} dim 'owner' | 'version'
   * @returns {string}
   */
  function buildVerOwnerListText(records, dim) {
    const groups = {};   // key: 版本\u0001姓名 → { ver, owner, ids: [] }
    records.forEach((rec) => {
      const ver = (rec.fields['发现发布'] || '').trim() || '未标注';
      const owner = ownerOf(rec);
      const key = ver + '\u0001' + owner;
      if (!groups[key]) groups[key] = { ver, owner, ids: [] };
      groups[key].ids.push(rec.id);
    });
    let list = Object.keys(groups).map((k) => groups[k]);
    if (dim === 'owner') {
      // 按姓名聚合：姓名 → 组内版本有序
      const byOwner = {};
      list.forEach((g) => {
        if (!byOwner[g.owner]) byOwner[g.owner] = [];
        byOwner[g.owner].push(g);
      });
      const sorted = [];
      Object.keys(byOwner).sort((a, b) => a.localeCompare(b, 'zh')).forEach((o) => {
        byOwner[o].sort((x, y) => x.ver.localeCompare(y.ver, 'zh'));
        sorted.push(...byOwner[o]);
      });
      list = sorted;
    } else {
      // 按版本聚合：版本 → 组内姓名有序
      const byVer = {};
      list.forEach((g) => {
        if (!byVer[g.ver]) byVer[g.ver] = [];
        byVer[g.ver].push(g);
      });
      const sorted = [];
      Object.keys(byVer).sort((a, b) => a.localeCompare(b, 'zh')).forEach((v) => {
        byVer[v].sort((x, y) => x.owner.localeCompare(y.owner, 'zh'));
        sorted.push(...byVer[v]);
      });
      list = sorted;
    }
    const lines = [];
    list.forEach((g) => {
      lines.push(`${g.ver}-${g.owner}（${g.ids.length}）`);
      g.ids.forEach((id) => lines.push(id));
      lines.push('');
    });
    return lines.join('\n').replace(/\n+$/, '\n');
  }

  return {
    FIELD_KEYS,
    DEFAULT_ORIGINAL_OWNERS: DEFAULT_ORIGINAL_OWNERS.slice(),
    emptyState,
    normalizeRow,
    cleanId,
    applyImport,
    reassign,
    updateVersion,
    updateStatus,
    setNote,
    removeBug,
    addPerson,
    renamePerson,
    removePerson,
    computeStats,
    computeAllVersionStats,
    migrateState,
    versionLessThan,
    undoSolved,
    lastSnapshot,
    todayStats,
    prevDayStats,
    sumDayStats,
    trend7,
    monthStats,
    findAbnormalIds,
    detectCsvEncoding,
    filterRecords,
    isActive,
    ownerOf,
    parseOwnerField,
    buildOwnerBugList,
    buildBugListText,
    buildVerOwnerListText
  };
});
