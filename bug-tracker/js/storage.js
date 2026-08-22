/**
 * storage.js — 数据持久化层（localStorage + 备份导出/恢复）
 *
 * Key 设计：
 *  - bugtracker:state  主数据（bugs/history/snapshots/people/appVersion）
 *  - bugtracker:meta   元信息（最近导入时间等）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.BugStorage = factory(root.BugEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const STATE_KEY = 'bugtracker:state';
  const META_KEY = 'bugtracker:meta';

  /** 读取状态；损坏/缺失时返回空状态（不抛异常） */
  function loadState(appVersion) {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return E.emptyState(appVersion);
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object' || !s.bugs) return E.emptyState(appVersion);
      if (!Array.isArray(s.people)) s.people = [];
      if (!Array.isArray(s.originalOwners)) s.originalOwners = E.emptyState(appVersion).originalOwners;
      if (!Array.isArray(s.history)) s.history = [];
      if (!Array.isArray(s.snapshots)) s.snapshots = [];
      return s;
    } catch (e) {
      console.error('[storage] 读取状态失败，使用空状态', e);
      return E.emptyState(appVersion);
    }
  }

  /** 保存状态；容量超限返回 false */
  function saveState(state) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      return { ok: true };
    } catch (e) {
      console.error('[storage] 保存失败', e);
      return {
        ok: false,
        error: '本地存储已满或不可用，请先导出备份并清理数据（导入视图 → 导出完整备份）'
      };
    }
  }

  /** 读取元信息 */
  function loadMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveMeta(meta) {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* 忽略 */ }
  }

  // ---------- 服务器共享同步（方案 B） ----------
  const API_STATE = '/api/state';

  /** 从服务器拉取共享状态；服务器无数据/不可用时返回 null */
  async function loadRemoteState(appVersion) {
    try {
      const res = await fetch(API_STATE, { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) {
        // 登录过期：跳转登录页
        window.location.href = '/login.html';
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.bugs) return null;
      if (!Array.isArray(data.people)) data.people = [];
      if (!Array.isArray(data.originalOwners)) data.originalOwners = E.emptyState(appVersion).originalOwners;
      if (!Array.isArray(data.history)) data.history = [];
      if (!Array.isArray(data.snapshots)) data.snapshots = [];
      return data;
    } catch (e) {
      console.warn('[storage] 服务器同步不可用（离线模式）', e);
      return null;
    }
  }

  /** 推送状态到服务器；成功 true / 失败 false */
  async function saveRemoteState(state) {
    try {
      const res = await fetch(API_STATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(state)
      });
      if (res.status === 401) {
        window.location.href = '/login.html';
        return false;
      }
      return res.ok;
    } catch (e) {
      console.warn('[storage] 服务器保存失败（离线模式）', e);
      return false;
    }
  }

  /**
   * 构建完整备份数据（多 Sheet 结构）
   * @returns {Object} { bugs:[], history:[], people:[], snapshots:[], exportedAt }
   */
  function buildBackup(state) {
    const bugs = Object.keys(state.bugs).map((id) => {
      const rec = state.bugs[id];
      return Object.assign({}, rec.fields, {
        '__首次发现日': rec.sys.firstSeenAt || '',
        '__最后解决日': rec.sys.lastSolvedAt || '',
        '__重新激活日': rec.sys.reactivatedAt || '',
        '__上次责任人': rec.sys.prevOwner || '',
        '__原始责任人': rec.sys.originalOwner || '',
        '__最近导入时间': rec.sys.lastImportedAt || '',
        '__手动改派过': rec.sys.manualReassigned ? '是' : '否',
        '__手动关闭时间': rec.sys.manualClosedAt || '',
        '__备注': rec.sys.note ? JSON.stringify(rec.sys.note) : ''
      });
    });
    const history = state.history.map((h) => {
      if (h.source === 'delete') {
        return {
          '编号': h.id, '原责任人': '', '新责任人': '',
          '变更时间': h.at, '变更来源': '删除', '删除原因': h.reason || '',
          '操作人': h.user || '', '标题': h.title || ''
        };
      }
      return {
        '编号': h.id, '原责任人': h.from, '新责任人': h.to,
        '变更时间': h.at,
        '变更来源': h.source === 'manual' ? '手动改派' : (h.source === 'verchange' ? '版本变更' : (h.source === 'statuschange' ? '状态变更' : '导入更新')),
        '__变更明细': h.changes && h.changes.length ? JSON.stringify(h.changes) : ''
      };
    });
    const people = state.people.map((p) => ({ '人员姓名': p }));
    const snapshots = state.snapshots.map((s) => ({
      '导入时间': s.at, '新增': s.imported, '解决': s.solved,
      '重新激活': s.reactivated, '未解决总数': s.totalActive,
      '版本明细': s.byVersion ? JSON.stringify(s.byVersion) : ''
    }));
    return {
      __backupMeta: { tool: 'bug-tracker', format: 'backup-v1', exportedAt: new Date().toISOString(), appVersion: state.appVersion },
      bugs, history, people, snapshots, originalOwners: state.originalOwners || []
    };
  }

  /**
   * 从备份数据恢复（覆盖式）
   * @returns {{ok:boolean, error?:string, summary?:object}}
   */
  function restoreBackup(state, backup) {
    if (!backup || !Array.isArray(backup.bugs)) {
      return { ok: false, error: '备份文件格式不正确：缺少 BUG 列表数据' };
    }
    const newState = E.emptyState(state.appVersion);
    newState.people = Array.isArray(backup.people) ? backup.people.map((p) => p['人员姓名'] || p).filter(Boolean) : [];
    if (Array.isArray(backup.originalOwners) && backup.originalOwners.length) {
      newState.originalOwners = backup.originalOwners;
    }

    // 恢复 bugs（从 fields + __ 系统字段）
    backup.bugs.forEach((row) => {
      const id = String(row['编号'] == null ? '' : row['编号']).trim();
      if (!id) return;
      const rec = E.normalizeRow(row, row['__最近导入时间'] || '');
      if (!rec) return;
      rec.sys.firstSeenAt = row['__首次发现日'] || null;
      rec.sys.lastSolvedAt = row['__最后解决日'] || null;
      rec.sys.reactivatedAt = row['__重新激活日'] || null;
      rec.sys.prevOwner = row['__上次责任人'] || '';
      rec.sys.originalOwner = row['__原始责任人'] || '';
      rec.sys.lastImportedAt = row['__最近导入时间'] || null;
      rec.sys.manualReassigned = row['__手动改派过'] === '是';
      rec.sys.manualClosedAt = row['__手动关闭时间'] || null;
      // 备注恢复（兼容旧备份无 __备注 字段）
      let note = null;
      if (row['__备注']) {
        try { note = JSON.parse(row['__备注']); } catch (e) { note = null; }
      }
      rec.sys.note = note;
      newState.bugs[id] = rec;
    });

    newState.history = (backup.history || []).map((h) => {
      if (h['变更来源'] === '删除') {
        return {
          id: String(h['编号']), from: '', to: '', at: h['变更时间'] || '',
          source: 'delete', reason: h['删除原因'] || '',
          user: h['操作人'] || '', title: h['标题'] || ''
        };
      }
      // 变更来源：手动改派 / 版本变更 / 导入更新；导入更新带 __变更明细（v1.24.0）
      let changes = null;
      if (h['__变更明细']) {
        try { changes = JSON.parse(h['__变更明细']); } catch (e) { changes = null; }
      }
      let src = 'import';
      if (h['变更来源'] === '手动改派') src = 'manual';
      else if (h['变更来源'] === '版本变更') src = 'verchange';
      else if (h['变更来源'] === '状态变更') src = 'statuschange';
      return {
        id: String(h['编号']), from: h['原责任人'] || '', to: h['新责任人'] || '',
        at: h['变更时间'] || '', source: src, changes
      };
    });

    newState.snapshots = (backup.snapshots || []).map((s) => {
      let bv = {};
      if (s['版本明细']) {
        try { bv = JSON.parse(s['版本明细']); } catch (e) { bv = {}; }
      }
      return {
        at: s['导入时间'], imported: Number(s['新增']) || 0, solved: Number(s['解决']) || 0,
        reactivated: Number(s['重新激活']) || 0, totalActive: Number(s['未解决总数']) || 0,
        byVersion: bv
      };
    });

    return {
      ok: true,
      summary: {
        bugs: Object.keys(newState.bugs).length,
        history: newState.history.length,
        people: newState.people.length,
        snapshots: newState.snapshots.length
      },
      state: newState
    };
  }

  return {
    STATE_KEY, META_KEY,
    loadState, saveState, loadMeta, saveMeta,
    buildBackup, restoreBackup,
    loadRemoteState, saveRemoteState
  };
});
