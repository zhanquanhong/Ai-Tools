/**
 * app.js — BUG 跟踪工具主应用（UI 渲染 + 交互）
 * 依赖：engine.js / storage.js / parser.js / xlsx.full.min.js / echarts.min.js
 */
(function () {
  'use strict';

  const APP_VERSION = '1.41.0';
  // 更新日志从后端 API 拉取（data/changelog.json），不再硬编码在前端
  let CHANGELOG = [];
  // 历史更新日志已迁移至 data/changelog.json（63 条，v1.0.0 ~ v1.33.1），由 /api/changelog 提供

  // ---------- 全局状态 ----------  ];

  // ---------- 全局状态 ----------
  const Engine = window.BugEngine;
  const Storage = window.BugStorage;
  const Parser = window.BugParser;

  let state = Storage.loadState(APP_VERSION);
  // 存量数据迁移：升级后自动补齐旧数据缺口（如快照 versionCounts），保证新逻辑展示正确
  (function migrateOnBoot() {
    const mig = Engine.migrateState(state, APP_VERSION);
    state = mig.state;
    if (mig.changed) {
      Storage.saveState(state);
      console.log('[migrate] 存量数据已升级至 v' + APP_VERSION);
    }
  })();
  let currentView = 'dashboard';
  let pendingImport = null;       // 待确认的导入解析结果
  let activeFilters = {};         // 列筛选 { colName: {type,value} }
  let quickSearch = '';
  let ownerSortDir = 0;           // 当前责任人列排序：0=默认(未排序) 1=升序 -1=降序
  let selectedBugId = null;       // BUG 列表当前选中行（点击持久高亮，点其他行切换，再点同行取消）
  let trendChart = null;
  let monthChart = null;
  let syncMode = 'local';         // 'local' 离线 / 'shared' 共享
  let savingRemote = false;
  let currentUser = '';           // 当前登录用户（备注/删除操作人记录，本地模式为空）
  let currentUserRole = localStorage.getItem('bugtracker:role') || 'user';  // admin=管理员（可导入），user=普通（仅查看）

  // ---------- DOM 快捷引用 ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- 工具函数 ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** 复制文本到剪贴板：优先 Clipboard API，http 环境自动降级 execCommand；成功提示 */
  function copyText(text, successMsg) {
    const done = () => showAlert(successMsg || '已复制');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { done(); return; }
        showAlert('复制失败，请手动选择复制', true);
      } catch (e) {
        showAlert('复制失败，请手动选择复制', true);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function showAlert(msg, isError) {
    const el = $('#globalAlert');
    el.textContent = msg;
    el.className = 'global-alert' + (isError ? ' error' : '');
    el.classList.remove('hidden');
    clearTimeout(showAlert._t);
    showAlert._t = setTimeout(() => el.classList.add('hidden'), 6000);
  }
  function save() {
    const r = Storage.saveState(state);
    if (!r.ok) showAlert(r.error, true);
    // 共享模式：推送到服务器（异步，不阻塞）
    if (syncMode === 'shared' && !savingRemote) {
      savingRemote = true;
      Storage.saveRemoteState(state).then((ok) => {
        savingRemote = false;
        if (!ok) showAlert('⚠️ 服务器同步失败，数据已存本机（可能被其他操作覆盖，请稍后重试）', true);
      });
    }
    return r.ok;
  }

  /** 启动时同步服务器共享数据 */
  async function initRemoteSync() {
    const remote = await Storage.loadRemoteState(APP_VERSION);
    if (remote) {
      // 服务器有共享数据：以服务器为准（团队共享），本机缓存覆盖
      state = remote;
      // 服务器数据也可能是旧版本 → 同样走迁移
      const mig = Engine.migrateState(state, APP_VERSION);
      state = mig.state;
      if (mig.changed) Storage.saveState(state);
      syncMode = 'shared';
      Storage.saveState(state); // 更新本机缓存
      renderAll();
    } else {
      // 服务器无数据/不可用：本机模式
      syncMode = 'local';
      // 若本机有数据，尝试推送到服务器开启共享（首次使用）
      if (Object.keys(state.bugs).length > 0) {
        const ok = await Storage.saveRemoteState(state);
        if (ok) syncMode = 'shared';
      }
    }
    renderSyncBadge();
  }

  function renderSyncBadge() {
    const el = $('#syncBadge');
    if (!el) return;
    if (syncMode === 'shared') {
      el.textContent = '☁️ 团队共享';
      el.className = 'sync-badge shared';
      el.title = '数据已与服务器同步，团队所有人可见';
    } else {
      el.textContent = '💻 本机模式';
      el.className = 'sync-badge local';
      el.title = '服务器不可用，数据仅存本机浏览器（离线模式）';
    }
  }

  /** 获取当前登录用户（备注/删除操作人记录）；服务器不可用时留空 */
  async function fetchCurrentUser() {
    try {
      const res = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) { window.location.href = '/login.html'; return; }
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.user) {
        currentUser = data.user;
        currentUserRole = data.role || 'user';
        localStorage.setItem('bugtracker:role', currentUserRole);
        applyRolePermission();
        renderUserTag();
      }
    } catch (e) { /* 离线模式，currentUser 保持空 */ }
  }

  /** 顶栏用户标签：显示当前账号（管理员标注），点击切换账号（v1.26.0） */
  function renderUserTag() {
    const el = $('#userTag');
    if (!el) return;
    if (currentUser) {
      el.textContent = `👤 ${currentUser}${currentUserRole === 'admin' ? '·管理员' : ''}`;
      el.style.display = '';
      el.title = '点击切换账号';
    } else {
      el.style.display = 'none';
    }
  }

  /** 切换账号：调用登出接口并跳转登录页（v1.26.0；v1.26.1 去掉 confirm——内嵌浏览器中 confirm 可能被禁用导致点击无反应） */
  function bindUserTag() {
    const el = $('#userTag');
    if (!el) return;
    el.onclick = async () => {
      try { await fetch('/api/logout', { cache: 'no-store', credentials: 'same-origin' }); } catch (e) { /* 忽略 */ }
      localStorage.removeItem('bugtracker:role');
      window.location.href = '/login.html';
    };
  }

  /** 角色权限：admin 可见「导入 BUG」「版本管理」；普通用户隐藏（仅查看，不能导入/回滚） */
  function applyRolePermission() {
    const isAdmin = (currentUserRole || localStorage.getItem('bugtracker:role') || 'user') === 'admin';
    const navImport = $('.nav-item[data-view="import"]');
    if (navImport) navImport.style.display = isAdmin ? '' : 'none';
    const navVersions = $('.nav-item[data-view="versions"]');
    if (navVersions) navVersions.style.display = isAdmin ? '' : 'none';
    if (!isAdmin && currentView === 'import') switchView('dashboard');
    if (!isAdmin && currentView === 'versions') switchView('dashboard');
  }
  window.__bugtrackerApplyRole = (role) => {   // __TEST_HOOK__：冒烟测试切换角色用
    if (role) {
      currentUserRole = role;
      localStorage.setItem('bugtracker:role', role);
    }
    applyRolePermission();
  };
  function renderAll() {
    renderNavCounts();
    renderLastImport();
    renderDashboard();
    renderList();
    renderPeople();
  }

  // ---------- 导航 ----------
  function switchView(view) {
    currentView = view;
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
    ['import', 'dashboard', 'list', 'people', 'loginrecords', 'versions'].forEach((v) => {
      const el = $('#view-' + v);
      if (el) el.style.display = v === view ? '' : 'none';
    });
    if (view === 'dashboard') renderDashboard();
    if (view === 'list') renderList();
    if (view === 'people') renderPeople();
    if (view === 'loginrecords') loadLoginRecords();
    if (view === 'versions') loadBackupView();
  }

  function renderNavCounts() {
    const stats = Engine.computeStats(state, state.overdueDays);
    $('#navListCnt').textContent = stats.totalActive;
    $('#navPeopleCnt').textContent = state.people.length;
  }

  function renderLastImport() {
    const snap = Engine.lastSnapshot(state);
    const el = $('#lastImportInfo');
    if (!snap) { el.innerHTML = '尚未导入数据'; return; }
    const days = Math.floor((Date.now() - new Date(snap.at).getTime()) / 86400000);
    const warn = days >= 1 ? ' · <b style="color:#d99a00">距上次导入 ' + days + ' 天</b>' : '';
    el.innerHTML = `最近导入：<b>${fmtTime(snap.at)}</b>${warn}`;
  }

  // ---------- 视图：导入 ----------
  function initImportView() {
    const dz = $('#dropzone');
    const input = $('#fileInput');

    $('#pickFile').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); input.value = ''; });

    ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    $('#btnConfirmImport').addEventListener('click', confirmImport);
    $('#btnCancelImport').addEventListener('click', () => { pendingImport = null; $('#importPreview').classList.add('hidden'); });

    $('#btnExportBackup').addEventListener('click', exportBackup);
    $('#btnImportBackup').addEventListener('click', () => $('#backupInput').click());
    $('#backupInput').addEventListener('change', handleBackupFile);
    $('#btnExportCsv').addEventListener('click', exportCurrentCsv);
    $('#btnClearData').addEventListener('click', openClearModal);
    $('#btnClearOk').addEventListener('click', confirmClearData);
  }

  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const res = await Parser.parseFile(e.target.result, file.name);
      if (!res.ok) { showAlert(res.error, true); return; }
      if (!res.hasIdColumn) { showAlert(res.missingIdWarning, true); return; }
      pendingImport = res;
      renderMapTable(res);
      $('#fileMeta').textContent = `文件：${file.name} · ${res.rowCount} 行 · ${res.columns.length} 列`;
      $('#importPreview').classList.remove('hidden');
      $('#importResult').classList.add('hidden');
    };
    reader.onerror = () => showAlert('文件读取失败', true);
    reader.readAsArrayBuffer(file);
  }

  /** 字段映射表：14 个标准字段 ← 导入列（自动猜测） */
  function renderMapTable(res) {
    const cols = res.columns;
    const guess = (kw) => cols.find((c) => c.indexOf(kw) !== -1) || '';
    const mappings = Engine.FIELD_KEYS.map((k) => ({
      field: k,
      matched: guess(k),
      required: k === '编号'
    }));
    const tbody = $('#mapTable');
    tbody.innerHTML = mappings.map((m) => `
      <tr>
        <td style="width:130px;font-weight:600">${m.field} ${m.required ? '<span style="color:#e85418">*</span>' : ''}</td>
        <td>
          <select data-field="${m.field}">
            <option value="">— 不映射 —</option>
            ${cols.map((c) => `<option value="${c}" ${c === m.matched ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </td>
        <td>${m.matched ? '<span class="map-ok">✓ 自动匹配</span>' : (m.required ? '<span class="map-warn">需手动指定</span>' : '<span class="map-ok">—</span>')}</td>
      </tr>`).join('');
    $('#mapTable').dataset.columns = JSON.stringify(cols);
  }

  function getMapping() {
    const map = {};
    $$('#mapTable select').forEach((sel) => {
      if (sel.value) map[sel.dataset.field] = sel.value;
    });
    return map;
  }

  function confirmImport() {
    if (!pendingImport) return;
    const map = getMapping();
    if (!map['编号']) { showAlert('必须映射「编号」列（主键）', true); return; }

    // 按映射重建行
    const rows = pendingImport.rows.map((r) => {
      const obj = {};
      Object.keys(map).forEach((field) => {
        obj[field] = r[map[field]] == null ? '' : r[map[field]];
      });
      return obj;
    });

    const nowIso = new Date().toISOString();
    const result = Engine.applyImport(state, rows, nowIso);
    const saved = save();

    pendingImport = null;
    $('#importPreview').classList.add('hidden');

    if (!saved) return;

    // 漏导防护：>30% 消失需要二次确认 —— 此处已产生告警则提示
    const warnHtml = result.warnings.length
      ? `<div style="color:#b33a3a;margin-top:8px">⚠️ ${result.warnings.join('；')}</div>` : '';
    // 未导入行提示：缺编号的行（含编号清洗后为空的隐藏字符行）
    let skipHtml = '';
    if (result.skippedRows && result.skippedRows.length) {
      const shown = result.skippedRows.slice(0, 5).map((s) =>
        `第 ${s.row} 行${s.hint ? `（${escapeHtml(s.hint)}）` : ''}`).join('、');
      skipHtml = `<div style="color:#b33a3a;margin-top:8px;background:#fdeaea;border:1px solid #f0c4c4;border-radius:6px;padding:8px 10px">
        ⚠️ <b>${result.skippedRows.length}</b> 行未导入成功（编号缺失或含隐藏字符）：
        ${shown}${result.skippedRows.length > 5 ? ` 等 ${result.skippedRows.length} 行` : ''}
      </div>`;
    }
    // 编号被清洗提示：全角空格/换行/零宽字符 → 已自动纠正
    let cleanHtml = '';
    if (result.cleanedIds && result.cleanedIds.length) {
      const shown = result.cleanedIds.slice(0, 3).map((c) =>
        `<code>${escapeHtml(c.from)}</code> → <code>${escapeHtml(c.to)}</code>`).join('、');
      cleanHtml = `<div style="color:#d99a00;margin-top:8px;background:#fdf6ec;border:1px solid #f0dca8;border-radius:6px;padding:8px 10px">
        ℹ️ <b>${result.cleanedIds.length}</b> 个编号含隐藏字符（全角空格/换行等），已自动清洗后导入：${shown}${result.cleanedIds.length > 3 ? ' 等' : ''}
      </div>`;
    }
    // 版本变更提示（v1.23.0）：编号对应版本号以最新导入为准同步更新，单独罗列
    let verChangeHtml = '';
    if (result.versionChanges && result.versionChanges.length) {
      const shown = result.versionChanges.slice(0, 8).map((c) =>
        `<code>${escapeHtml(c.id)}</code>（${escapeHtml(c.from)} → ${escapeHtml(c.to)}）`).join('、');
      verChangeHtml = `<div style="color:#8a5a00;margin-top:8px;background:#fdf6ec;border:1px solid #f0dca8;border-radius:6px;padding:8px 10px">
        🔄 <b>${result.versionChanges.length}</b> 个 BUG 版本已同步更新（以最新导入为准）：
        ${shown}${result.versionChanges.length > 8 ? ` 等 ${result.versionChanges.length} 个` : ''}
      </div>`;
    }
    const el = $('#importResult');
    el.className = 'import-result ' + (result.warnings.length || result.skippedRows.length ? 'warn' : 'ok');
    el.innerHTML = `
      <b>✅ 导入完成（${fmtTime(nowIso)}）</b>
      <div class="nums">
        <div><b class="n-total">${result.totalCount}</b>总条数${result.rawCount !== result.totalCount ? `<span style="font-size:11px;color:#989898">（原始 ${result.rawCount} 行）</span>` : ''}</div>
        <div><b class="n-add">${result.imported}</b>新增</div>
        <div><b class="n-exist">${result.existingCount}</b>已存在</div>
        <div><b class="n-fix">${result.solved}</b>判定解决</div>
        <div><b class="n-re">${result.reactivated}</b>重新激活</div>
        <div><b class="n-own">${result.ownerChanges}</b>更新责任人</div>
        <div><b class="n-ver">${result.versionChanges ? result.versionChanges.length : 0}</b>版本变更</div>
        <div><b class="n-skip">${result.ownerSkipped}</b>跳过白名单</div>
      </div>
      ${skipHtml}
      ${cleanHtml}
      ${verChangeHtml}
      ${result.solved ? `<div class="undo-row"><button class="btn btn-plain btn-sm" id="btnUndoSolved">↩ 撤销判定解决（${result.solved} 个）</button><span style="font-size:11px;color:#989898">误判时点击，恢复为未解决</span></div>` : ''}
      ${warnHtml}`;
    el.classList.remove('hidden');
    const undoBtn = $('#btnUndoSolved');
    if (undoBtn) {
      undoBtn.onclick = () => {
        if (!confirm(`确定撤销本次「判定解决」的 ${result.solved} 个 BUG？将恢复为未解决状态。`)) return;
        const n = Engine.undoSolved(state, result.solvedIds);
        save();
        renderAll();
        el.innerHTML = `<b>↩ 已撤销 ${n} 个 BUG 的解决判定，恢复为未解决</b>`;
        el.className = 'import-result ok';
      };
    }

    // 自动备份提示
    setTimeout(() => {
      if (confirm('导入成功！建议立即备份数据（导出完整备份 .xlsx），防止浏览器数据丢失。\n\n现在导出备份？')) {
        exportBackup();
      }
    }, 300);

    renderAll();
  }

  // ---------- 备份导出 / 恢复 ----------
  async function exportBackup() {
    const backup = Storage.buildBackup(state);
    const sheets = [
      { name: 'BUG列表', rows: backup.bugs },
      { name: '变更历史', rows: backup.history },
      { name: '人员名单', rows: backup.people },
      { name: '快照记录', rows: backup.snapshots }
    ];
    await Parser.exportXlsx(sheets, `bug-tracker-备份-${todayStr()}.xlsx`);
    showAlert('完整备份已导出（4 个 Sheet：BUG列表/变更历史/人员名单/快照记录）');
  }

  function handleBackupFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const res = await Parser.parseFile(ev.target.result, file.name);
      if (!res.ok) { showAlert(res.error, true); return; }
      // 判断是否为完整备份：存在 __首次发现日 等系统字段
      const sample = res.rows[0] || {};
      const isBackup = res.rowCount > 0 && Object.keys(sample).some((k) => k.indexOf('__') === 0);
      if (!isBackup) {
        showAlert('该文件是普通 BUG 列表，请通过「导入 BUG」导入；恢复备份需使用「导出完整备份」生成的文件', true);
        return;
      }
      // 尝试解析备份（fields 映射）
      const backup = {
        bugs: res.rows,
        history: [],
        people: [],
        snapshots: []
      };
      // 多 sheet 备份：xlsx 才有，csv 单 sheet —— 用 parseFile 只拿到第一个 sheet
      // 此处对 xlsx 重新解析全部 sheet
      if (file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')) {
        try {
          const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
          wb.SheetNames.forEach((sn) => {
            const ws = wb.Sheets[sn];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (sn === '变更历史') backup.history = rows;
            else if (sn === '人员名单') backup.people = rows;
            else if (sn === '快照记录') backup.snapshots = rows;
          });
        } catch (err) { console.error(err); }
      } else if (res.rowCount > 0 && res.columns.indexOf('原责任人') !== -1) {
        backup.history = res.rows;
      } else if (res.rowCount > 0 && res.columns.indexOf('人员姓名') !== -1) {
        backup.people = res.rows;
      }
      const restored = Storage.restoreBackup(state, backup);
      if (!restored.ok) { showAlert(restored.error, true); return; }
      // 显示确认框（恢复前自动备份当前数据）
      $('#restoreSummary').innerHTML = `
        备份导出时间：<b>${res.rows[0]['__最近导入时间'] ? fmtTime(res.rows[0]['__最近导入时间']) : '—'}</b><br>
        BUG 记录：<b>${restored.summary.bugs}</b> 条<br>
        变更历史：<b>${restored.summary.history}</b> 条<br>
        人员名单：<b>${restored.summary.people}</b> 人<br>
        快照记录：<b>${restored.summary.snapshots}</b> 次`;
      $('#restoreModal').classList.remove('hidden');
      window._pendingRestore = restored.state;
    };
    reader.onerror = () => showAlert('备份文件读取失败', true);
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  }

  function confirmRestore() {
    if (!window._pendingRestore) return;
    // 恢复前自动备份当前数据
    exportBackup();
    state = window._pendingRestore;
    window._pendingRestore = null;
    $('#restoreModal').classList.add('hidden');
    const saved = save();
    if (!saved) return;
    renderAll();
    switchView('dashboard');
    showAlert('✅ 备份恢复成功，数据已还原');
  }

  function exportCurrentCsv() {
    const recs = getFilteredRecords();
    const rows = recs.map((r) => Object.assign({}, r.fields));
    if (!rows.length) { showAlert('当前无数据可导出', true); return; }
    Parser.exportCsv(rows, `bug-list-${todayStr()}.csv`);
  }

  /** 导出问题清单：按当前版本筛选 + 责任人分组（txt） */
  function exportBugList() {
    const verList = getVerList();
    // 获取活跃 BUG（按版本筛选）
    let recs = Object.keys(state.bugs).map((id) => state.bugs[id]).filter((r) => Engine.isActive(r));
    if (verList.length) recs = recs.filter((r) => verList.indexOf((r.fields['发现发布'] || '').trim()) !== -1);
    if (!recs.length) { showAlert('当前筛选下没有未解决的 BUG 可导出', true); return; }
    const text = Engine.buildBugListText(recs);
    const verName = verList.length ? verList.join('+') : '全部版本';
    const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `问题清单-${verName}-${todayStr()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    showAlert(`✅ 已导出 ${recs.length} 个问题（${verName}）`);
  }

  /** 导出当前列表结果（版本-姓名 分组 txt）：按人员维度 / 按版本维度 */
  function exportVerOwnerList() {
    // v1.36.2：已关闭（手动关闭=非活跃）的 BUG 不导出，仅导出待跟进问题
    const recs = getFilteredRecords().filter((r) => Engine.isActive(r));
    if (!recs.length) { showAlert('当前列表没有可导出的 BUG', true); return; }
    // 弹窗选择维度
    $('#exportDimModal').classList.remove('hidden');
  }

  function doExportVerOwner(dim) {
    $('#exportDimModal').classList.add('hidden');
    const recs = getFilteredRecords().filter((r) => Engine.isActive(r));
    if (!recs.length) { showAlert('当前列表没有可导出的 BUG', true); return; }
    const text = Engine.buildVerOwnerListText(recs, dim);
    const dimName = dim === 'owner' ? '按人员' : '按版本';
    const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `问题清单-${dimName}-${todayStr()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    showAlert(`✅ 已导出 ${recs.length} 个问题（${dimName}维度，格式：版本-姓名（条数））`);
  }

  // ---------- 数据清零 ----------
  function openClearModal() {
    const stats = Engine.computeStats(state, state.overdueDays);
    $('#clearSummary').innerHTML = `
      当前数据概况：<br>
      BUG 记录：<b>${Object.keys(state.bugs).length}</b> 条（未解决 <b>${stats.totalActive}</b>）<br>
      责任人变更历史：<b>${state.history.length}</b> 条<br>
      快照记录：<b>${state.snapshots.length}</b> 次<br>
      人员名单：<b>${state.people.length}</b> 人（保留）<br>
      原始负责人名单：<b>${(state.originalOwners || []).length}</b> 人（保留）`;
    // 二次确认：输入「确认」才启用执行按钮
    const input = $('#clearConfirmInput');
    const okBtn = $('#btnClearOk');
    if (input && okBtn) {
      input.value = '';
      okBtn.disabled = true;
      input.oninput = () => { okBtn.disabled = input.value.trim() !== '确认'; };
      input.onkeydown = (e) => { if (e.key === 'Enter' && !okBtn.disabled) confirmClearData(); };
    }
    $('#clearModal').classList.remove('hidden');
    if (input) setTimeout(() => input.focus(), 50);
  }

  function confirmClearData() {
    const input = $('#clearConfirmInput');
    if (input && input.value.trim() !== '确认') {
      showAlert('请输入「确认」后再执行清零', true);
      return;
    }
    // 清空前自动导出备份
    exportBackup();
    // 保留配置：人员名单 + 原始负责人名单；清空业务数据
    state.bugs = {};
    state.history = [];
    state.snapshots = [];
    const saved = save();
    $('#clearModal').classList.add('hidden');
    if (!saved) return;
    renderAll();
    switchView('dashboard');
    showAlert('✅ 数据已清零（人员名单与原始负责人名单已保留），备份文件已下载');
  }

  // ---------- 视图：看板 ----------
  function getVerList() {
    const v = state.dashboardVersions;
    return Array.isArray(v) ? v.filter(Boolean) : [];
  }

  function renderDashboard() {
    const verList = getVerList();
    const stats = Engine.computeStats(state, state.overdueDays, verList);
    const snap = Engine.lastSnapshot(state);
    const anyData = Object.keys(state.bugs).length > 0;

    $('#noImportBanner').classList.toggle('hidden', anyData);
    const staleEl = $('#staleBanner');
    if (snap) {
      const days = Math.floor((Date.now() - new Date(snap.at).getTime()) / 86400000);
      if (days >= 1) {
        staleEl.classList.remove('hidden');
        staleEl.innerHTML = `⚠️ 今日尚未导入 BUG 列表（最近导入 ${fmtTime(snap.at)}，已过去 ${days} 天），看板为最近一次快照数据。`;
      } else {
        staleEl.classList.add('hidden');
      }
    } else {
      staleEl.classList.add('hidden');
    }

    // 版本多选下拉：动态填充所有版本
    const allVers = Object.keys(state.bugs).map((id) => state.bugs[id].fields['发现发布'] || '未标注')
      .filter((v, i, a) => a.indexOf(v) === i).sort();
    renderVerMulti(allVers, verList);

    // 统计卡片（v1.35.1：今日新增/今日解决 = 当天多次导入累计 + 当日手动关闭调整，与趋势图口径一致）
    const today = Engine.todayStats(state, new Date(), verList.length ? verList : undefined);
    const todayImported = today.imported;
    const todaySolved = today.solved;
    const prev = Engine.prevDayStats(state, new Date(), verList.length ? verList : undefined);
    const impDelta = prev ? todayImported - prev.imported : null;
    const solDelta = prev ? todaySolved - prev.solved : null;
    const prevLabel = prev ? (prev.dayKey === today.dayKey ? '' : `（${prev.dayKey.slice(5)}）`) : '';
    // 累计统计（按版本过滤；未选版本=全部）：累计问题 = 范围全部 BUG（含已解决），已修复 = 范围非活跃数
    const scopedBugs = Object.keys(state.bugs).map((id) => state.bugs[id]).filter((r) => {
      if (!verList.length) return true;
      return verList.indexOf(((r.fields['发现发布'] || '').trim() || '未标注')) !== -1;
    });
    const totalAll = scopedBugs.length;
    const fixedAll = scopedBugs.filter((r) => !Engine.isActive(r)).length;
    const cards = [
      { cls: 'c1', label: '今日新增', value: todayImported, delta: impDelta == null ? '首次快照' : (impDelta >= 0 ? `▲ 较${prevLabel || '昨日'} +${impDelta}` : `▼ 较${prevLabel || '昨日'} ${impDelta}`), up: impDelta != null && impDelta >= 0 },
      { cls: 'c2', label: '今日解决', value: todaySolved, delta: solDelta == null ? '首次快照' : (solDelta >= 0 ? `▲ 较${prevLabel || '昨日'} +${solDelta}` : `▼ 较${prevLabel || '昨日'} ${solDelta}`), up: solDelta != null && solDelta >= 0 },
      { cls: 'c3', label: '未解决总数', value: stats.totalActive, delta: `净增 ${(todayImported - todaySolved) >= 0 ? '+' : ''}${todayImported - todaySolved}` },
      { cls: 'c4', label: `停留超期(≥${stats.overdueThreshold}天)`, value: stats.overdue, delta: `占未解决 ${stats.totalActive ? Math.round(stats.overdue / stats.totalActive * 100) : 0}%` },
      { cls: 'c5', label: '累计问题', value: totalAll, delta: `已修复 ${fixedAll} · 未解决 ${totalAll - fixedAll}` }
    ];
    $('#statCards').innerHTML = cards.map((c) => `
      <div class="card ${c.cls}"><div class="bar"></div>
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
        <div class="delta ${c.up ? 'up' : ''}">${c.delta}</div>
      </div>`).join('');

    // 版本统计（v1.22.0 口径统一：数量=当前活跃 BUG 按版本分组，与严重程度卡片/列表同源；
    // 始终显示全部活跃版本，选中版本高亮，点击版本号多选切换筛选）
    const verAll = Engine.computeAllVersionStats(state);
    const verActiveSum = Object.keys(verAll.byActive).reduce((a, v) => a + verAll.byActive[v], 0);
    renderBarStats('#verStats', verAll.byActive, 'ver-bar', '#verTotal',
      '共 ' + Object.keys(verAll.byActive).length + ' 个版本 · 未解决 ' + verActiveSum + ' 个 BUG',
      verActiveSum, verList, (verName) => {
        // 点击版本号 → 多选 toggle（版本筛选；拖拽调整展示顺序见 renderBarStats）
        const list = getVerList();
        const idx = list.indexOf(verName);
        if (idx !== -1) list.splice(idx, 1); else list.push(verName);
        state.dashboardVersions = list;
        save();
        renderDashboard();
      }, undefined, loadVerOrder(), '点击切换版本筛选(可多选) · 按住拖拽可调整展示顺序');
    // 「全部版本」链接：有筛选时高亮可点，无筛选时置灰
    const allLink = $('#btnShowAllVers');
    if (allLink) {
      allLink.classList.toggle('active', verList.length > 0);
      allLink.onclick = () => {
        if (state.dashboardVersions && state.dashboardVersions.length) { state.dashboardVersions = []; save(); renderDashboard(); }
      };
    }
    // 严重程度统计（按版本过滤；点击级别 → 跳转列表筛选该级别，联动看板版本筛选）
    renderBarStats('#sevStats', stats.bySeverity, (k) => sevBarClass(k), '#sevTotal',
      Object.keys(stats.bySeverity).length + ' 个级别', stats.totalActive, undefined, (sevName) => {
        activeFilters = { '严重程度': { type: 'enum', value: [sevName] } };
        const dv = state.dashboardVersions || [];
        if (dv.length) activeFilters['发现发布'] = { type: 'enum', value: dv.slice() };
        quickSearch = '';
        const qs = $('#quickSearch');
        if (qs) qs.value = '';
        switchView('list');
        renderList();
      });

    // 趋势图（按版本过滤）
    const trendSel = $('#trendDays');
    if (trendSel) trendSel.value = String(state.trendDays || 7);
    renderTrend(verList);
    renderMonthStats(verList);

    // 责任人维度（按版本过滤）
    renderOwnerStats(stats);
  }

  /** 渲染版本多选下拉 */
  function renderVerMulti(allVers, verList) {
    const btn = $('#btnVerMulti');
    const pop = $('#verMultiPop');
    const list = $('#verMultiList');
    if (!btn || !pop || !list) return;
    if (verList.length === 0) {
      btn.textContent = '全部版本 ▾';
      btn.classList.remove('has-filter');
    } else {
      btn.textContent = `已选 ${verList.length} 个版本 ▾`;
      btn.classList.add('has-filter');
    }
    list.innerHTML = allVers.map((v) => `
      <label><input type="checkbox" value="${escapeHtml(v)}" ${verList.indexOf(v) !== -1 ? 'checked' : ''}> ${escapeHtml(v)}</label>`).join('')
      || '<div style="color:#b0b0b0;font-size:12px;padding:4px 0">暂无版本数据</div>';
    btn.onclick = (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); };
    document.querySelectorAll('#verMultiList input[type=checkbox]').forEach((cb) => {
      cb.onclick = (e) => e.stopPropagation();
    });
    $('#btnVerClear').onclick = () => {
      document.querySelectorAll('#verMultiList input').forEach((cb) => { cb.checked = false; });
    };
    $('#btnVerApply').onclick = () => {
      const sel = Array.from(document.querySelectorAll('#verMultiList input:checked')).map((cb) => cb.value);
      state.dashboardVersions = sel;
      save();
      pop.classList.add('hidden');
      renderDashboard();
    };
  }

  function sevBarClass(k) {
    if (String(k).indexOf('严重') !== -1) return 'sev-s1-bar';
    if (String(k).indexOf('一般') !== -1 || String(k).indexOf('中等') !== -1) return 'sev-s2-bar';
    return 'sev-s3-bar';
  }

  // 版本展示顺序偏好（用户拖拽自定义，localStorage 持久化）
  const VER_ORDER_KEY = 'bugtracker:verorder';
  function loadVerOrder() {
    try { const v = JSON.parse(localStorage.getItem(VER_ORDER_KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveVerOrder(list) {
    try { localStorage.setItem(VER_ORDER_KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }

  function renderBarStats(sel, map, barCls, totalSel, totalText, totalAll, highlightList, onClick, subMap, sortOrder, tipText) {
    const keys = Object.keys(map);
    const total = keys.reduce((a, k) => a + map[k], 0);
    $(totalSel).textContent = totalText;
    const hlList = Array.isArray(highlightList) ? highlightList : (highlightList ? [highlightList] : []);
    const max = Math.max(1, ...keys.map((k) => map[k]));
    const orderList = Array.isArray(sortOrder) ? sortOrder : [];
    // 排序：用户自定义顺序优先，未定义项按数量降序排在后面
    const items = keys.sort((a, b) => {
      const ia = orderList.indexOf(a), ib = orderList.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return map[b] - map[a];
    }).map((k) => {
      const pct = total ? Math.round(map[k] / total * 1000) / 10 : 0;
      const cls = typeof barCls === 'function' ? barCls(k) : barCls;
      const width = Math.max(4, Math.round(map[k] / max * 100));
      const hl = hlList.indexOf(k) !== -1 ? ' style="outline:2px solid #e85418;outline-offset:2px;background:#fdf6f2"' : '';
      const tip = tipText || (subMap
        ? `导入 ${map[k]} 个 · 当前未解决 ${subMap[k] || 0} 个${onClick ? ' · 点击切换版本筛选(可多选)' : ''}`
        : (onClick ? '点击查看对应问题列表' : ''));
      return `<div class="stat-item" data-col="${encodeURIComponent(k)}" title="${tip}"${hl}>
        <div class="name">${k}</div>
        <div class="track"><i class="${cls}" style="width:${width}%"></i></div>
        <div class="num">${map[k]}</div><div class="pct">${pct}%</div></div>`;
    }).join('');
    $(sel).innerHTML = items || '<div style="color:#b0b0b0;font-size:12px;padding:8px 0">暂无数据</div>';
    // 点击统计项：自定义回调（版本切换 / 严重程度筛选）
    $$(sel + ' .stat-item').forEach((el) => {
      el.addEventListener('click', () => {
        const colName = decodeURIComponent(el.dataset.col);
        if (onClick) onClick(colName);
      });
    });
  }

  /**
   * 版本统计卡片拖拽排序（鼠标事件实现，兼容内嵌浏览器/触摸环境，不依赖 HTML5 DnD）：
   * 按住版本行上下拖动 → 其他行实时让位 → 松开保存顺序（localStorage 持久化）
   */
  function bindVerDrag() {
    const list = $('#verStats');
    if (!list) return;
    let drag = null;          // { el, startY, moved }
    let suppressClick = false;
    list.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.stat-item');
      if (!item) return;
      drag = { el: item, startY: e.clientY, moved: false };
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientY - drag.startY) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.el.classList.add('dragging');
        document.body.classList.add('dragging-active');
      }
      // 鼠标下方的目标行（排除被拖行自身）
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under && under.closest ? under.closest('.stat-item') : null;
      if (target && target !== drag.el) {
        const rect = target.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        // 实时重排：目标行下方/上方让位（insertBefore 自动处理移动）
        list.insertBefore(drag.el, after ? target.nextSibling : target);
      }
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      if (drag.moved) {
        suppressClick = true;
        const order = Array.from(list.querySelectorAll('.stat-item')).map((x) => decodeURIComponent(x.dataset.col));
        saveVerOrder(order);
        renderDashboard();
      }
      drag.el.classList.remove('dragging');
      document.body.classList.remove('dragging-active');
      drag = null;
    });
    // 拖拽结束后的 click 拦截：拖动不算点击（避免误触发版本筛选）
    document.addEventListener('click', (e) => {
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
        suppressClick = false;
      }
    }, true);
  }

  function renderTrend(version) {
    const days = state.trendDays || 7;
    const trend = Engine.trend7(state, new Date().toISOString(), days, version || '');
    const el = $('#trendChart');
    if (!trendChart) {
      trendChart = echarts.init(el);
      window.addEventListener('resize', () => trendChart && trendChart.resize());
    }
    const hasAny = trend.some((d) => d.hasData);
    // x 轴标签密度控制：天数多时每隔几天显示一个
    const labelStep = days > 14 ? Math.ceil(days / 14) : 1;
    const axisLabels = trend.map((d, i) => (i % labelStep === 0 ? d.label : ''));
    trendChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['新增', '解决'], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 40, right: 16, top: 30, bottom: 24 },
      xAxis: { type: 'category', data: trend.map((d) => d.label), axisLabel: { fontSize: 10, interval: labelStep - 1 } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
      series: [
        { name: '新增', type: 'bar', data: trend.map((d) => d.hasData ? d.imported : null), itemStyle: { color: '#5ac2ff', borderRadius: [3, 3, 0, 0] }, barMaxWidth: days > 30 ? 10 : 18 },
        { name: '解决', type: 'bar', data: trend.map((d) => d.hasData ? d.solved : null), itemStyle: { color: '#45bf82', borderRadius: [3, 3, 0, 0] }, barMaxWidth: days > 30 ? 10 : 18 }
      ],
      graphic: hasAny ? [] : [{
        type: 'text', left: 'center', top: 'middle', style: {
          text: '暂无数据\n请先导入 BUG 列表', textAlign: 'center', fill: '#b0b0b0', fontSize: 13
        }
      }]
    });
  }

  /**
   * 按月统计（v1.39.0）：按编号建单日期归月
   * 口径：数据跟随版本筛选（与「累计问题」卡片一致，数字可对上）；
   *      月份下拉始终展示全部已有月份（v1.38.0 用户要求），筛选内无数据的月份显示 0 柱
   */
  function renderMonthStats(version) {
    const sel = $('#monthFilter');
    const allStats = Engine.monthStats(state);                 // 下拉选项：全量月份
    const stats = Engine.monthStats(state, version || '');     // 图表数据：版本筛选口径
    // 编号异常检测（v1.40.0）：有异常时面板显示警示标签，点击弹窗罗列明细
    const abnormal = Engine.findAbnormalIds(state);
    const tag = $('#abnormalTag');
    if (tag) {
      if (abnormal.length) {
        tag.classList.remove('hidden');
        $('#abnormalCount').textContent = abnormal.length;
      } else {
        tag.classList.add('hidden');
      }
    }
    const prevVal = sel ? sel.value : 'all';
    if (sel) {
      const opts = ['<option value="all">全部月份</option>']
        .concat(allStats.map((m) => `<option value="${m.month}">${m.label}</option>`)).join('');
      sel.innerHTML = opts;
      sel.value = allStats.some((m) => m.month === prevVal) ? prevVal : 'all';
    }
    // 选中某月 → 只展示该月；筛选内无该月数据 → 显示 0 柱
    let data = stats;
    if (sel && sel.value !== 'all') {
      const hit = stats.filter((m) => m.month === sel.value);
      if (hit.length) {
        data = hit;
      } else {
        const allHit = allStats.filter((m) => m.month === sel.value);
        data = allHit.length ? [{ month: allHit[0].month, label: allHit[0].label, total: 0, fixed: 0, active: 0 }] : [];
      }
    }
    const el = $('#monthChart');
    if (!monthChart) {
      monthChart = echarts.init(el);
      window.addEventListener('resize', () => monthChart && monthChart.resize());
    }
    const hasAny = data.some((m) => m.total > 0);
    const labels = data.map((m) => m.label);
    // 汇总行（v1.40.1）：当前版本筛选口径下 建单/已修复/未解决，与「累计问题」卡片对照
    const sumTotal = stats.reduce((a, m) => a + m.total, 0);
    const sumFixed = stats.reduce((a, m) => a + m.fixed, 0);
    const sumActive = sumTotal - sumFixed;
    const sumEl = $('#monthSummary');
    if (sumEl) {
      sumEl.innerHTML = `共 <b>${sumTotal}</b> 个 · 已修复 <b style="color:#45bf82">${sumFixed}</b> · 未解决 <b style="color:#e85418">${sumActive}</b>
        <span class="month-summary-hint">（与「累计问题」卡片同口径，按当前版本筛选）</span>`;
    }
    // trigger:'axis' 时 formatter 收到数组（每系列一个对象），取首个的 dataIndex（v1.38.1 修复悬浮无提示）
    const fmtTip = (ps) => {
      const p = Array.isArray(ps) ? ps[0] : ps;
      const d = data[p.dataIndex];
      if (!d) return '';
      return `<b>${d.label}</b><br>建单 ${d.total} 个（已修复 ${d.fixed} · 未解决 ${d.active}）`;
    };
    monthChart.setOption({
      tooltip: { trigger: 'axis', formatter: fmtTip },
      legend: { data: ['建单', '已修复'], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 40, right: 16, top: 30, bottom: 24 },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { fontSize: 10 } },
      series: [
        { name: '建单', type: 'bar', data: data.map((m) => m.total), itemStyle: { color: '#5ac2ff', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 22, label: { show: true, position: 'top', fontSize: 10, color: '#5ac2ff' } },
        { name: '已修复', type: 'bar', data: data.map((m) => m.fixed), itemStyle: { color: '#45bf82', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 22, label: { show: true, position: 'top', fontSize: 10, color: '#45bf82' } }
      ],
      graphic: hasAny ? [] : [{
        type: 'text', left: 'center', top: 'middle', style: {
          text: '暂无数据\n请先导入 BUG 列表', textAlign: 'center', fill: '#b0b0b0', fontSize: 13
        }
      }]
    });
  }

  const AVATAR_COLORS = ['#e85418', '#5ac2ff', '#45bf82', '#fdbe31', '#9b6fe8', '#e8739a', '#2ba8a0', '#d99a00', '#6b8ae8', '#8a6d3b'];
  function avatarColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function renderOwnerStats(stats) {
    const owners = Object.keys(stats.byOwner).sort((a, b) => stats.byOwner[b].active - stats.byOwner[a].active);
    $('#ownerTotal').textContent = owners.length + ' 人';
    if (!owners.length) { $('#ownerStats').innerHTML = '<div style="color:#b0b0b0;font-size:12px;padding:8px 0">暂无数据</div>'; return; }
    const maxActive = Math.max(1, ...owners.map((o) => stats.byOwner[o].active));
    $('#ownerStats').innerHTML = owners.map((o, idx) => {
      const info = stats.byOwner[o];
      const width = Math.round(info.active / maxActive * 100);
      const overdueTag = info.overdue ? `<span class="badge-old">超期 ${info.overdue}</span>` : '';
      return `<div class="person-row" data-owner="${encodeURIComponent(o)}" title="点击查看 ${o} 的问题列表">
        <span class="owner-idx">${idx + 1}</span>
        <div class="avatar" style="background:${avatarColor(o)}">${o.charAt(0)}</div>
        <div class="person-meta"><div class="name">${o} ${overdueTag}</div>
        <div class="nums">未解决 ${info.active} · 超期 ${info.overdue}</div></div>
        <div class="person-bar"><i style="width:${width}%"></i></div>
      </div>`;
    }).join('');
    // 点击人员 → 跳转 BUG 列表并自动筛选该人员（联动看板版本筛选，与统计口径一致）
    $$('#ownerStats .person-row').forEach((el) => {
      el.addEventListener('click', () => {
        const owner = decodeURIComponent(el.dataset.owner);
        activeFilters = { '当前责任人': { type: 'enum', value: [owner] } };
        const dv = state.dashboardVersions || [];
        if (dv.length) activeFilters['发现发布'] = { type: 'enum', value: dv.slice() };
        quickSearch = '';
        const qs = $('#quickSearch');
        if (qs) qs.value = '';
        switchView('list');
        renderList();
      });
    });
  }

  // ---------- 视图：BUG 列表 ----------
  /** 列表可见范围（列表=最新导入数据）：活跃 BUG + 手动「关闭」且仍在最近一次导入数据中的 BUG */
  function inListScope(rec) {
    if (Engine.isActive(rec)) return true;
    if (!rec.sys.manualClosedAt) return false;
    const snap = Engine.lastSnapshot(state);
    return snap != null && rec.sys.lastImportedAt != null && rec.sys.lastImportedAt >= snap.at;
  }

  function getFilteredRecords() {
    const recs = Object.keys(state.bugs).map((id) => state.bugs[id]).filter(inListScope);
    let out = Engine.filterRecords(recs, activeFilters);
    if (quickSearch) {
      const q = quickSearch.toLowerCase();
      out = out.filter((r) => {
        return Engine.FIELD_KEYS.some((k) => {
          const v = String(r.fields[k] || '').toLowerCase();
          return v.indexOf(q) !== -1;
        });
      });
    }
    // 当前责任人列排序（0=默认不排序，1=升序，-1=降序）
    if (ownerSortDir !== 0) {
      out = out.slice().sort((a, b) => {
        const oa = Engine.ownerOf(a);
        const ob = Engine.ownerOf(b);
        const cmp = oa.localeCompare(ob, 'zh');
        return ownerSortDir > 0 ? cmp : -cmp;
      });
    }
    return out;
  }

  const STATUS_COLORS = {
    '新建': 'st-0', '新': 'st-0', '打开': 'st-0', 'open': 'st-0',
    '处理中': 'st-1', '进行中': 'st-1', '开发中': 'st-1', '修复中': 'st-1', 'in progress': 'st-1',
    '退回': 'st-2', '已退回': 'st-2', '驳回': 'st-2', 'rejected': 'st-2', '重新打开': 'st-2', 'reopen': 'st-2',
    '已解决': 'st-3', '已关闭': 'st-3', '关闭': 'st-3', 'resolved': 'st-3', 'closed': 'st-3', '已修复': 'st-3', 'fixed': 'st-3'
  };
  function statusClass(s) {
    return STATUS_COLORS[s] || 'st-1';
  }
  /** 展示状态：手动「关闭」优先于导入状态 */
  function displayStatus(rec) {
    if (rec.sys.manualClosedAt) return '关闭';
    return String(rec.fields['状态'] || '').trim() || '—';
  }
  function sevClass(s) {
    if (String(s).indexOf('严重') !== -1) return 'sev-s1';
    if (String(s).indexOf('一般') !== -1 || String(s).indexOf('中等') !== -1) return 'sev-s2';
    return 'sev-s3';
  }

  // ---------- BUG 列表列宽拖拽 ----------
  const COLW_KEY = 'bugtracker:colwidths';
  function loadColWidths() {
    try { const w = JSON.parse(localStorage.getItem(COLW_KEY)); return w && typeof w === 'object' ? w : {}; } catch (e) { return {}; }
  }
  function saveColWidths(w) {
    try { localStorage.setItem(COLW_KEY, JSON.stringify(w)); } catch (e) { /* 忽略 */ }
  }
  function colWidthOf(c) {
    const w = loadColWidths();
    return w[c] || '';
  }

  function renderList() {
    const recs = getFilteredRecords();
    const stats = Engine.computeStats(state, state.overdueDays);
    const showColumns = Engine.FIELD_KEYS;

    $('#filterInfo').innerHTML = `共 <b>${recs.length}</b> 条${Object.keys(activeFilters).length ? ` · 已筛选 <b style="color:#e85418">${Object.keys(activeFilters).length}</b> 列` : ''}`;
    // 清除筛选按钮：常驻显示；有筛选时高亮并显示筛选列数
    const hasFilter = Object.keys(activeFilters).length > 0 || !!quickSearch;
    const clearBtn = $('#btnClearFilters');
    if (clearBtn) {
      clearBtn.disabled = !hasFilter;
      clearBtn.classList.toggle('has-filter', hasFilter);
      clearBtn.textContent = hasFilter ? `清除筛选(${Object.keys(activeFilters).length})` : '清除筛选';
    }
    // 「今日新增」快捷筛选按钮高亮
    const tnBtn = $('#btnTodayNew');
    if (tnBtn) tnBtn.classList.toggle('has-filter', !!activeFilters.__todayNew);

    // 表头（含筛选图标）；「当前责任人」列支持排序（点击表头切换 升序/降序/默认）
    // 列宽：colgroup 控制（用户拖拽宽度存 localStorage，未设置用默认宽度）
    $('#bugColgroup').innerHTML = showColumns.map((c) => `<col style="${colWidthOf(c) ? 'width:' + colWidthOf(c) + 'px' : ''}">`).join('') + '<col>';
    $('#bugThead').innerHTML = '<tr>' + showColumns.map((c) => {
      const isFiltered = activeFilters[c];
      let sortMark = '';
      let extra = '';
      if (c === '当前责任人') {
        sortMark = ownerSortDir === 1 ? ' ▲' : (ownerSortDir === -1 ? ' ▼' : ' ⇅');
        extra = ` data-sort="1" style="cursor:pointer" title="点击排序（升序/降序/默认）"`;
      }
      return `<th class="${isFiltered ? 'filter-active' : ''}"${extra}><span class="th-resizer" data-col="${c}" title="拖动调整列宽"></span>${c} <span class="f-icon" data-col="${c}">${isFiltered ? '✓' : '▾'}</span><span class="sort-mark">${sortMark}</span></th>`;
    }).join('') + '<th>操作</th></tr>';

    // 表体
    const tbody = $('#bugTbody');
    if (!recs.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="' + (showColumns.length + 1) + '">暂无数据（未导入或筛选无结果）</td></tr>';
    } else {
      tbody.innerHTML = recs.map((rec) => {
        const f = rec.fields;
        const overdue = !isNaN(parseInt(f['停留天数'], 10)) && parseInt(f['停留天数'], 10) >= stats.overdueThreshold;
        const manualTag = rec.sys.manualReassigned ? '<span class="manual-tag" title="曾手动改派">手改</span>' : '';
        const prevOwner = rec.sys.prevOwner ? `<span class="badge-prev" title="上次责任人">← ${rec.sys.prevOwner}</span>` : '';
        const owner = Engine.ownerOf(rec);
        const unassigned = owner === '未分配';
        const note = rec.sys.note;
        const noteTag = note && note.text
          ? `<span class="note-tag" title="备注：${escapeHtml(note.text)}${note.user ? `（${escapeHtml(note.user)} ${fmtTime(note.at)}）` : ''}">💬</span>`
          : '';
        const titleNoteTag = note && note.text
          ? `<span class="note-tag" title="备注：${escapeHtml(note.text)}${note.user ? `（${escapeHtml(note.user)} ${fmtTime(note.at)}）` : ''}">💬</span>`
          : '';
        const cells = showColumns.map((c) => {
          let v = f[c] || '';
          if (c === '状态') v = `<span class="status-tag ${statusClass(displayStatus(rec))} status-cell" data-statusedit="${rec.id}" title="点击修改状态">${displayStatus(rec)}</span>`;
          else if (c === '严重程度') v = `<span class="${sevClass(v)}">${v || '—'}</span>`;
          else if (c === '编号') v = `<span class="col-id" title="双击选择单号复制">${v || '—'}</span>`;
          else if (c === '发现发布') v = `<span class="ver-cell" data-veredit="${rec.id}" title="点击修改版本">${v || '—'}</span>`;
          else if (c === '停留天数') v = `<span class="days ${overdue ? 'over' : ''}">${v || '0'}</span>`;
          else if (c === '当前责任人') v = `<span class="assign ${unassigned ? 'unassigned' : ''}"><span class="dot"></span><span class="owner-name" data-reassign="${rec.id}" title="点击改派责任人">${owner}</span></span> ${manualTag}${prevOwner}`;
          else if (c === '标题') v = `${titleNoteTag}<span class="col-title" title="${escapeHtml(v)}">${v || '—'}</span>`;
          else if (c === '描述') v = `<span class="col-desc" title="${escapeHtml(v)}">${v || '—'}</span>`;
          else if (c === '分析原因') v = `<span class="col-desc" title="${escapeHtml(v)}">${v || '—'}</span>`;
          else if (c === '退回原因') v = `<span class="col-desc" title="${escapeHtml(v)}">${v || '—'}</span>`;
          else if (c === '激活原因') v = `<span class="col-desc" title="${escapeHtml(v)}">${v || '—'}</span>`;
          else v = v || '—';
          return `<td>${v}</td>`;
        }).join('');
        return `<tr data-id="${rec.id}" class="${rec.id === selectedBugId ? 'row-selected' : ''}">${cells}<td>${noteTag}<span class="op-link" data-act="reassign" data-id="${rec.id}">改派</span><span class="op-link" data-act="note" data-id="${rec.id}">备注</span><span class="op-link" data-act="history" data-id="${rec.id}">历史</span><span class="op-link op-danger" data-act="delete" data-id="${rec.id}">删除</span></td></tr>`;
      }).join('');
    }

    // 表头筛选点击
    $$('#bugThead .f-icon').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        openFilterPop(el, el.dataset.col);
      };
    });
    // 列宽拖拽手柄（mousedown 拖动，mouseup 保存；click 阻断防止触发责任人列排序）
    $$('#bugThead .th-resizer').forEach((el) => {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const th = el.parentElement;
        const col = el.dataset.col;
        const startX = e.clientX;
        const startW = th.getBoundingClientRect().width;
        el.classList.add('active');
        document.body.classList.add('resizing');
        const onMove = (ev) => {
          const w = Math.max(60, Math.round(startW + (ev.clientX - startX)));
          const colEl = $('#bugColgroup').children[showColumns.indexOf(col)];
          if (colEl) colEl.style.width = w + 'px';
          th.style.width = w + 'px';
        };
        const onUp = () => {
          el.classList.remove('active');
          document.body.classList.remove('resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          // 保存拖拽目标宽度（col 建议值），与重渲染恢复值一致；auto 布局下 th 渲染宽受内容影响，不作为保存依据
          const colEl = $('#bugColgroup').children[showColumns.indexOf(col)];
          const w = Math.max(60, parseInt(colEl ? colEl.style.width : '', 10) || Math.round(th.getBoundingClientRect().width));
          const widths = loadColWidths();
          widths[col] = w;
          saveColWidths(widths);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
    // 「当前责任人」表头排序点击（点击列标题，非筛选图标）
    $$('#bugThead th[data-sort]').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('.f-icon')) return;   // 筛选图标走筛选弹层
        ownerSortDir = ownerSortDir === 0 ? 1 : (ownerSortDir === 1 ? -1 : 0);
        renderList();
      };
    });
    // 行操作
    $$('#bugTbody [data-act]').forEach((el) => {
      el.onclick = () => {
        if (el.dataset.act === 'reassign') openReassign(el.dataset.id);
        else if (el.dataset.act === 'note') openNote(el.dataset.id);
        else if (el.dataset.act === 'delete') openDeleteBug(el.dataset.id);
        else openHistory(el.dataset.id);
      };
    });
    // 行点击选中：点击行高亮并保持，点其他行切换，再点同一行取消；
    // 只切 class 不重渲染（重渲染会打断双击/拖选单元格文本）；按住拖动选文本（位移>3px）不触发选中
    $$('#bugTbody tr[data-id]').forEach((tr) => {
      let downX = 0, downY = 0;
      tr.addEventListener('mousedown', (e) => { downX = e.clientX; downY = e.clientY; });
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.op-link, [data-reassign]')) return;
        if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) return;
        const id = tr.dataset.id;
        selectedBugId = selectedBugId === id ? null : id;
        $$('#bugTbody tr.row-selected').forEach((r) => r.classList.remove('row-selected'));
        if (selectedBugId) tr.classList.add('row-selected');
      });
      // 双击行 → 弹出详细信息（含备注）；操作按钮/责任人/版本编辑/编号列（复制单号用）不触发
      tr.addEventListener('dblclick', (e) => {
        if (e.target.closest('.op-link, [data-reassign], [data-veredit], [data-statusedit], .col-id')) return;
        const id = tr.dataset.id;
        selectedBugId = id;
        $$('#bugTbody tr.row-selected').forEach((r) => r.classList.remove('row-selected'));
        tr.classList.add('row-selected');
        openDetail(id);
      });
    });
    // 责任人列点击姓名 → 弹出改派（操作列改派按钮不变）
    $$('#bugTbody [data-reassign]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        openReassign(el.dataset.reassign);
      };
    });
    // 发现发布列点击版本 → 行内下拉修改版本（v1.23.0）
    $$('#bugTbody [data-veredit]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        openVersionEdit(el.dataset.veredit, el);
      };
    });
    // 状态列点击状态 → 行内下拉修改状态（v1.32.0）
    $$('#bugTbody [data-statusedit]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        openStatusEdit(el.dataset.statusedit, el);
      };
    });
  }

  /** 列筛选弹层 */
  function openFilterPop(anchor, col) {
    const pop = $('#filterPop');
    const recs = Object.keys(state.bugs).map((id) => state.bugs[id]).filter(inListScope);
    const values = [];
    recs.forEach((r) => {
      const v = col === '当前责任人' ? Engine.ownerOf(r) : String(r.fields[col] || '');
      if (v && values.indexOf(v) === -1) values.push(v);
    });
    values.sort();

    const cur = activeFilters[col] || {};
    let html = `<h5>${col} 筛选</h5>`;
    if (col === '编号') {
      // 编号列：支持多单号输入（逗号/空格/换行分隔）
      const curVal = cur.type === 'ids' ? (cur.value || []).join(', ') : '';
      html += `<input type="text" class="filter-input" id="fpIds" placeholder="输入编号关键词，如：56701" value="${escapeHtml(curVal)}">
        <div style="font-size:11px;color:#989898;margin-bottom:6px">支持模糊匹配（包含即命中）· 多个关键词用逗号/空格分隔，匹配任一</div>`;
    } else if (values.length <= 30 && values.length > 0) {
      // 枚举多选（v1.41.0：支持全选/清空快捷操作，全选=该列不过滤）
      const sel = (cur.type === 'enum' && cur.value) ? cur.value : [];
      html += `<div class="filter-opts-tools">
        <button type="button" class="btn btn-plain btn-xs" id="fpSelAll">全选</button>
        <button type="button" class="btn btn-plain btn-xs" id="fpSelNone">清空</button>
        <span class="filter-opts-count">${sel.length ? '已选 ' + sel.length + '/' + values.length : ''}</span>
      </div>`;
      html += `<div class="filter-opts">${values.map((v) =>
        `<label><input type="checkbox" value="${v.replace(/"/g, '&quot;')}" ${sel.indexOf(v) !== -1 ? 'checked' : ''}> ${v}</label>`).join('')}</div>`;
    } else if (values.length > 30) {
      // 文本搜索
      html += `<input type="text" class="filter-input" placeholder="输入关键词…" value="${(cur.type === 'text' ? cur.value : '') || ''}">`;
    } else {
      html += `<div style="color:#b0b0b0;font-size:12px;padding:4px 0">该列暂无数据</div>`;
    }
    // 数字/日期列增强
    const isNumber = values.every((v) => v !== '' && !isNaN(parseFloat(v)));
    const isDate = values.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v));
    if (isNumber) {
      html += `<div class="filter-range">
        <input type="number" placeholder="最小" id="fpMin" value="${cur.type === 'number' && cur.min != null ? cur.min : ''}">
        ~<input type="number" placeholder="最大" id="fpMax" value="${cur.type === 'number' && cur.max != null ? cur.max : ''}">
      </div>`;
    }
    if (isDate) {
      html += `<div class="filter-range">
        <input type="date" id="fpFrom" value="${cur.type === 'date' && cur.from ? cur.from : ''}">
        ~<input type="date" id="fpTo" value="${cur.type === 'date' && cur.to ? cur.to : ''}">
      </div>`;
    }
    html += `<div class="filter-actions">
      <button class="btn btn-plain btn-sm" id="fpClear">清除本列</button>
      <button class="btn btn-plain btn-sm" id="fpClearAll">清除全部</button>
      <button class="btn btn-primary btn-sm" id="fpOk">确定</button>
    </div>`;
    pop.innerHTML = html;
    pop.classList.remove('hidden');

    // 定位
    const r = anchor.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (left + 270 > window.innerWidth) left = window.innerWidth - 280;
    if (top + 260 > window.innerHeight) top = Math.max(6, r.top - 260);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    const collect = () => {
      // 编号列：多单号匹配
      if (col === '编号') {
        const raw = $('#fpIds').value;
        const ids = raw.split(/[,，\s\n\r\t]+/).map((s) => s.trim()).filter(Boolean);
        if (ids.length) activeFilters[col] = { type: 'ids', value: ids };
        else delete activeFilters[col];
        return;
      }
      const type = values.length > 30 ? 'text' : (isNumber && $('#fpMin') ? 'number' : (isDate && $('#fpFrom') ? 'date' : 'enum'));
      if (type === 'enum') {
        const checked = $$('#filterPop .filter-opts input:checked').map((i) => i.value);
        // v1.41.0：全选 = 该列不过滤（与不筛选等价，避免冗余筛选条件）
        if (checked.length && checked.length === values.length) delete activeFilters[col];
        else if (checked.length) activeFilters[col] = { type, value: checked };
        else delete activeFilters[col];
      } else if (type === 'text') {
        const v = $('#filterPop .filter-input').value.trim();
        if (v) activeFilters[col] = { type, value: v };
        else delete activeFilters[col];
      } else if (type === 'number') {
        const min = $('#fpMin').value === '' ? null : parseFloat($('#fpMin').value);
        const max = $('#fpMax').value === '' ? null : parseFloat($('#fpMax').value);
        if (min != null || max != null) activeFilters[col] = { type, min, max };
        else delete activeFilters[col];
      } else if (type === 'date') {
        const from = $('#fpFrom').value || null;
        const to = $('#fpTo').value || null;
        if (from || to) activeFilters[col] = { type, from, to };
        else delete activeFilters[col];
      }
    };

    $('#fpOk').onclick = () => { collect(); pop.classList.add('hidden'); renderList(); };
    // v1.41.0：枚举多选全选/清空快捷操作
    const fpSelAll = $('#fpSelAll');
    if (fpSelAll) fpSelAll.onclick = () => {
      $$('#filterPop .filter-opts input').forEach((i) => { i.checked = true; });
      const n = $$('#filterPop .filter-opts input:checked').length;
      const cnt = $('#filterPop .filter-opts-count');
      if (cnt) cnt.textContent = '已选 ' + n + '/' + values.length;
    };
    const fpSelNone = $('#fpSelNone');
    if (fpSelNone) fpSelNone.onclick = () => {
      $$('#filterPop .filter-opts input').forEach((i) => { i.checked = false; });
      const cnt = $('#filterPop .filter-opts-count');
      if (cnt) cnt.textContent = '';
    };
    $('#fpClear').onclick = () => { delete activeFilters[col]; pop.classList.add('hidden'); renderList(); };
    $('#fpClearAll').onclick = () => {
      activeFilters = {};
      quickSearch = '';
      const qs = $('#quickSearch');
      if (qs) qs.value = '';
      pop.classList.add('hidden');
      renderList();
    };
  }

  // ---------- 改派 ----------
  function renderReassignOptions(filter) {
    const kw = (filter || '').trim().toLowerCase();
    const opts = state.people
      .filter((p) => !kw || p.toLowerCase().indexOf(kw) !== -1)
      .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
      .join('');
    const sel = $('#reassignTarget');
    sel.innerHTML = opts || '<option value="">（无匹配人员，请先到人员管理添加）</option>';
    // 默认选中第一个
    if (sel.options.length && sel.options[0].value) sel.selectedIndex = 0;
  }

  function openReassign(id) {
    const rec = state.bugs[id];
    if (!rec) return;
    $('#reassignId').textContent = id;
    $('#reassignCur').textContent = Engine.ownerOf(rec);
    $('#reassignSearch').value = '';
    renderReassignOptions('');
    $('#reassignModal').classList.remove('hidden');
    $('#reassignTarget').dataset.id = id;
    setTimeout(() => $('#reassignSearch').focus(), 60);
  }

  /** 收集全部已有版本（含当前值） */
  function collectVersions() {
    const vers = [];
    Object.keys(state.bugs).forEach((id) => {
      const v = String(state.bugs[id].fields['发现发布'] || '').trim();
      if (v && vers.indexOf(v) === -1) vers.push(v);
    });
    return vers.sort();
  }

  /** 发现发布列行内修改版本：替换为下拉选择，change 即保存（v1.23.0） */
  function openVersionEdit(id, el) {
    const rec = state.bugs[id];
    if (!rec) return;
    const cur = (rec.fields['发现发布'] || '').trim();
    const vers = collectVersions();
    const sel = document.createElement('select');
    sel.className = 'ver-select';
    sel.dataset.id = id;
    sel.dataset.done = '0';
    const opts = [];
    if (cur && vers.indexOf(cur) === -1) opts.push(cur);
    vers.forEach((v) => { if (opts.indexOf(v) === -1) opts.push(v); });
    opts.forEach((v) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === cur) o.selected = true;
      sel.appendChild(o);
    });
    const custom = document.createElement('option');
    custom.value = '__custom__'; custom.textContent = '＋ 输入新版本…';
    sel.appendChild(custom);
    el.replaceWith(sel);
    sel.focus();
    sel.onchange = () => {
      sel.dataset.done = '1';
      let v = sel.value;
      if (v === '__custom__') {
        v = prompt('输入新版本号：', cur);
        if (!v || !v.trim()) { renderList(); return; }
        v = v.trim();
      }
      const r = Engine.updateVersion(state, id, v, new Date().toISOString(), currentUser);
      save();
      renderList();
      if (!r.ok) showAlert(r.error, true);
    };
    sel.onblur = () => { if (sel.dataset.done !== '1') renderList(); };
  }

  /** 状态枚举值集合：数据中已出现的状态 + 手动「关闭」（v1.32.0） */
  function collectStatuses() {
    const sts = ['关闭'];
    Object.keys(state.bugs).forEach((id) => {
      const v = String(state.bugs[id].fields['状态'] || '').trim();
      if (v && sts.indexOf(v) === -1) sts.push(v);
    });
    return sts;
  }

  /** 状态列行内修改状态：替换为下拉选择，change 即保存（v1.32.0） */
  function openStatusEdit(id, el) {
    const rec = state.bugs[id];
    if (!rec) return;
    const cur = displayStatus(rec);
    const sts = collectStatuses();
    const sel = document.createElement('select');
    sel.className = 'ver-select';
    sel.dataset.id = id;
    sel.dataset.done = '0';
    const opts = [];
    if (cur !== '—' && sts.indexOf(cur) === -1) opts.push(cur);
    sts.forEach((v) => { if (opts.indexOf(v) === -1) opts.push(v); });
    opts.forEach((v) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === cur) o.selected = true;
      sel.appendChild(o);
    });
    el.replaceWith(sel);
    sel.focus();
    sel.onchange = () => {
      sel.dataset.done = '1';
      if (sel.value === cur) { renderList(); return; }
      const newVal = sel.value;
      renderList(); // 先恢复状态标签，等待确认
      showConfirm(`确定将状态从「${cur}」改为「${newVal}」？`, () => {
        const r = Engine.updateStatus(state, id, newVal, new Date().toISOString(), currentUser);
        save();
        renderAll();   // 全量刷新：列表 + 看板统计卡片（未解决总数/今日解决等）同步更新
        if (!r.ok) showAlert(r.error, true);
      });
    };
    sel.onblur = () => { if (sel.dataset.done !== '1') renderList(); };
  }

  function initReassignSearch() {
    const input = $('#reassignSearch');
    if (!input) return;
    input.addEventListener('input', () => renderReassignOptions(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmReassign(); }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const sel = $('#reassignTarget');
        if (sel.options.length) { sel.selectedIndex = Math.min(sel.selectedIndex + 1, sel.options.length - 1); }
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const sel = $('#reassignTarget');
        if (sel.options.length) { sel.selectedIndex = Math.max(sel.selectedIndex - 1, 0); }
      }
    });
  }

  function confirmReassign() {
    const id = $('#reassignTarget').dataset.id;
    const target = $('#reassignTarget').value;
    if (!target) { showAlert('人员名单为空，请先到「人员管理」添加人员', true); return; }
    const r = Engine.reassign(state, id, target, new Date().toISOString(), state.people);
    if (!r.ok) { showAlert(r.error, true); return; }
    if (r.changed) {
      const saved = save();
      if (!saved) return;
      showAlert(`✅ 已改派：${id} → ${target}`);
    } else {
      showAlert('责任人未变化');
    }
    $('#reassignModal').classList.add('hidden');
    renderAll();
  }

  // ---------- 备注 ----------
  function openNote(id) {
    const rec = state.bugs[id];
    if (!rec) return;
    const note = rec.sys.note;
    $('#noteId').textContent = id;
    $('#noteTitle').textContent = rec.fields['标题'] || '—';
    $('#noteText').value = note && note.text ? note.text : '';
    $('#noteMeta').textContent = note && note.text
      ? `上次更新：${fmtTime(note.at)}${note.user ? ` · ${note.user}` : ''}`
      : '暂无备注';
    $('#noteModal').classList.remove('hidden');
    $('#noteText').dataset.id = id;
    setTimeout(() => $('#noteText').focus(), 60);
  }

  /** 通用确认弹窗（替代原生 confirm，兼容内嵌浏览器/WebView） */
  function showConfirm(message, onOk) {
    $('#confirmMsg').textContent = message;
    $('#btnConfirmOk').onclick = () => {
      $('#confirmModal').classList.add('hidden');
      if (onOk) onOk();
    };
    $('#btnConfirmCancel').onclick = () => { $('#confirmModal').classList.add('hidden'); };
    $('#confirmModal').classList.remove('hidden');
  }

  /** 版本名展示：V13.2.0 → v13.2.0；AI助手3.3.0 → AI助手v3.3.0（数字前补 v） */
  function fmtVerForStats(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return s;
    if (/^v/i.test(s)) return 'v' + s.slice(1);
    const m = s.search(/\d/);
    if (m > 0) return s.slice(0, m) + 'v' + s.slice(m);
    return s;
  }

  /** 生成问题统计文本（截止时间 + 各版本总计与严重程度分布） */
  function buildStatsText() {
    const snap = Engine.lastSnapshot(state);
    const now = snap ? new Date(snap.at) : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const lines = [`截止${now.getMonth() + 1}月${now.getDate()}日${pad(now.getHours())}:${pad(now.getMinutes())}（最后一次导入BUG报表的时间）`];
    // 版本范围：看板所选版本优先；未选 → 全部活跃版本（版本卡展示顺序：用户排序优先，其余按数量降序）
    const verAll = Engine.computeAllVersionStats(state);
    let versions;
    if (state.dashboardVersions && state.dashboardVersions.length) {
      versions = state.dashboardVersions.slice();
    } else {
      const orderList = loadVerOrder();
      versions = Object.keys(verAll.byActive).sort((a, b) => {
        const ia = orderList.indexOf(a), ib = orderList.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return verAll.byActive[b] - verAll.byActive[a];
      });
    }
    versions.forEach((ver, i) => {
      if (i > 0) lines.push('');
      const sevMap = { '一般': 0, '严重': 0, '提示': 0 };
      const extra = {};
      let total = 0;
      Object.keys(state.bugs).forEach((id) => {
        const rec = state.bugs[id];
        if (!Engine.isActive(rec)) return;
        if (((rec.fields['发现发布'] || '').trim() || '未标注') !== ver) return;
        total++;
        const sev = (rec.fields['严重程度'] || '').trim() || '未标注';
        if (sev in sevMap) sevMap[sev]++; else extra[sev] = (extra[sev] || 0) + 1;
      });
      lines.push(`${fmtVerForStats(ver)}，当前总计${total}个，`);
      ['一般', '严重', '提示'].forEach((k) => lines.push(`${k}问题${sevMap[k]}个`));
      Object.keys(extra).forEach((k) => lines.push(`${k}问题${extra[k]}个`));
    });
    return lines.join('\n');
  }

  /** 打开问题统计弹窗（按当前看板版本选择生成内容） */
  function openStatsModal() {
    $('#statsText').textContent = buildStatsText();
    $('#statsModal').classList.remove('hidden');
  }

  /** 复制兜底：textarea + execCommand（不支持 Clipboard API 的环境） */
  function fallbackCopyText(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
    cb();
  }

  function confirmNote() {
    const id = $('#noteText').dataset.id;
    if (!id) return;
    const text = $('#noteText').value;
    const r = Engine.setNote(state, id, text, currentUser, new Date().toISOString());
    if (!r.ok) { showAlert(r.error, true); return; }
    const saved = save();
    if (!saved) return;
    $('#noteModal').classList.add('hidden');
    showAlert(r.cleared ? '备注已清除' : '✅ 备注已保存');
    renderAll();
  }

  // ---------- BUG 详情（双击行弹出） ----------
  function openDetail(id) {
    const rec = state.bugs[id];
    if (!rec) return;
    const f = rec.fields;
    const note = rec.sys.note;
    $('#dtModalId').textContent = id;
    $('#dtModalVer').textContent = f['发现发布'] || '—';
    $('#dtTitle').textContent = f['标题'] || '—';

    const shortFields = [
      ['严重程度', `<span class="${sevClass(f['严重程度'])}">${escapeHtml(f['严重程度'] || '—')}</span>`],
      ['状态', `<span class="status-tag ${statusClass(displayStatus(rec))}">${escapeHtml(displayStatus(rec))}</span>`],
      ['当前责任人', escapeHtml(Engine.ownerOf(rec))],
      ['发现发布', escapeHtml(f['发现发布'] || '—')],
      ['停留天数', escapeHtml(f['停留天数'] || '0')],
      ['创建人', escapeHtml(f['创建人'] || '—')],
      ['最近修改时间', escapeHtml(f['最近修改时间'] || '—')],
      ['最近更新人', escapeHtml(f['最近更新人'] || '—')]
    ];
    const longFields = ['描述', '分析原因', '退回原因', '激活原因'];

    let html = shortFields.map((kv) => `<div class="detail-cell"><div class="detail-label">${kv[0]}</div><div class="detail-val">${kv[1]}</div></div>`).join('');
    html += longFields.map((k) => `<div class="detail-cell full"><div class="detail-label">${k}</div><div class="detail-val pre">${escapeHtml(f[k] || '—')}</div></div>`).join('');
    $('#dtGrid').innerHTML = html;

    $('#dtNote').innerHTML = note && note.text
      ? `<div class="detail-note-text">${escapeHtml(note.text)}</div><div class="detail-note-meta">${note.user ? `${escapeHtml(note.user)} · ` : ''}${fmtTime(note.at)}</div>`
      : '<div class="detail-note-empty">暂无备注</div>';

    $('#detailModal').dataset.id = id;
    $('#detailModal').classList.remove('hidden');
  }

  // ---------- 删除 BUG ----------
  function openDeleteBug(id) {
    const rec = state.bugs[id];
    if (!rec) return;
    $('#delId').textContent = id;
    $('#delTitle').textContent = rec.fields['标题'] || '—';
    $('#delOwner').textContent = Engine.ownerOf(rec);
    $('#delReason').value = '';
    $('#delReason').dataset.id = id;
    $('#deleteModal').classList.remove('hidden');
    setTimeout(() => $('#delReason').focus(), 60);
  }

  function confirmDeleteBug() {
    const id = $('#delReason').dataset.id;
    if (!id) return;
    const reason = $('#delReason').value;
    if (!reason.trim()) { showAlert('请填写删除原因（必填，将记录在变更历史中）', true); return; }
    const r = Engine.removeBug(state, id, reason, currentUser, new Date().toISOString());
    if (!r.ok) { showAlert(r.error, true); return; }
    const saved = save();
    if (!saved) return;
    $('#deleteModal').classList.add('hidden');
    showAlert(`✅ 已删除 ${id}，看板统计已同步更新`);
    renderAll();
  }

  // ---------- 变更历史 ----------
  function openHistory(id) {
    const items = state.history.filter((h) => h.id === id);
    const rec = state.bugs[id];
    let html = `<div style="font-size:12px;color:#787878;margin-bottom:10px">BUG：<b style="color:#1f2329">${id}</b>
      ${rec ? ` · 当前责任人：<b style="color:#e85418">${Engine.ownerOf(rec)}</b>` : '<span style="color:#d64545">（已删除）</span>'}</div>`;
    if (!items.length) {
      html += '<div style="color:#b0b0b0;font-size:12px;padding:10px 0">暂无记录</div>';
    } else {
      html += items.slice().reverse().map((h) => {
        if (h.source === 'delete') {
          return `<div class="history-item del-item">
            <span style="color:#d64545;font-weight:700">🗑 删除</span>
            <span class="src src-del">删除</span>
            <span class="time">${fmtTime(h.at)}${h.user ? ` · ${escapeHtml(h.user)}` : ''}</span>
            <div style="width:100%;color:#484848;font-size:12px;padding:2px 0">原因：${escapeHtml(h.reason || '—')}</div>
          </div>`;
        }
        if (h.source === 'verchange') {
          return `<div class="history-item">
            <span style="color:#8a5a00;font-weight:600">🔄 版本变更</span>
            <span>${h.from || '—'}</span><span class="arrow">→</span><span>${h.to}</span>
            <span class="src src-ver">版本变更</span>
            <span class="time">${fmtTime(h.at)}${h.user ? ` · ${escapeHtml(h.user)}` : ''}</span>
          </div>`;
        }
        if (h.source === 'statuschange') {
          return `<div class="history-item">
            <span style="color:#2f9e63;font-weight:600">🔒 状态变更</span>
            <span>${h.from || '—'}</span><span class="arrow">→</span><span>${h.to}</span>
            <span class="src src-ver">状态变更</span>
            <span class="time">${fmtTime(h.at)}${h.user ? ` · ${escapeHtml(h.user)}` : ''}</span>
          </div>`;
        }
        if (h.source === 'import' && h.changes && h.changes.length) {
          const ownerPart = h.from
            ? `<div style="padding-left:2px">当前责任人：<span style="color:#b0b0b0">${escapeHtml(h.from)}</span> → <span style="color:#e85418">${escapeHtml(h.to)}</span></div>` : '';
          return `<div class="history-item">
            <span style="font-weight:600">📥 导入更新</span>
            <span class="src src-import">导入更新</span>
            <span class="time">${fmtTime(h.at)}</span>
            <div style="width:100%;font-size:12px;color:#484848;padding:2px 0;line-height:1.7">
              ${ownerPart}
              ${h.changes.map((c) => `<div style="padding-left:2px">${escapeHtml(c.field)}：<span style="color:#b0b0b0">${escapeHtml(c.from || '—')}</span> → <span style="color:#e85418">${escapeHtml(c.to || '—')}</span></div>`).join('')}
            </div>
          </div>`;
        }
        return `<div class="history-item">
          <span>${h.from || '—'}</span><span class="arrow">→</span><span>${h.to}</span>
          <span class="src ${h.source === 'manual' ? 'src-manual' : 'src-import'}">${h.source === 'manual' ? '手动改派' : '导入更新'}</span>
          <span class="time">${fmtTime(h.at)}</span>
        </div>`;
      }).join('');
    }
    $('#historyBody').innerHTML = html;
    $('#historyModal').classList.remove('hidden');
  }

  // ---------- 视图：人员管理 ----------
  function renderPeople() {
    renderWhitelist();
    const stats = Engine.computeStats(state, state.overdueDays);
    const tbody = $('#peopleTbody');
    if (!state.people.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">暂无人员，请添加（导入时新责任人也会自动加入）</td></tr>';
      return;
    }
    tbody.innerHTML = state.people.map((p, idx) => {
      const info = stats.byOwner[p] || { active: 0, overdue: 0 };
      return `<tr>
        <td><span class="avatar" style="background:${avatarColor(p)};display:inline-flex;margin-right:8px">${p.charAt(0)}</span>${p}</td>
        <td>${info.active}</td>
        <td>${info.overdue}</td>
        <td>
          <span class="op-link" data-act="rename" data-idx="${idx}">重命名</span>
          <span class="op-link" data-act="del" data-idx="${idx}" style="color:#d64545">删除</span>
        </td>
      </tr>`;
    }).join('');
    $$('#peopleTbody [data-act]').forEach((el) => {
      el.onclick = () => {
        const idx = Number(el.dataset.idx);
        if (el.dataset.act === 'rename') renamePerson(idx);
        else removePerson(idx);
      };
    });
  }

  // ---------- 原始负责人白名单管理 ----------
  function renderWhitelist() {
    const list = state.originalOwners || [];
    const tags = $('#whitelistTags');
    if (!tags) return;
    tags.innerHTML = list.length ? list.map((name) => `
      <span class="wl-tag">${escapeHtml(name)} <span class="x" data-wl="${encodeURIComponent(name)}" title="移出白名单">✕</span></span>`).join('')
      : '<span style="color:#b0b0b0;font-size:12px">白名单为空（保护规则不生效，建议添加或恢复默认）</span>';
    const cnt = $('#whitelistCount');
    if (cnt) cnt.textContent = `共 ${list.length} 人`;
    $$('#whitelistTags .x').forEach((el) => {
      el.onclick = () => {
        const name = decodeURIComponent(el.dataset.wl);
        state.originalOwners = (state.originalOwners || []).filter((n) => n !== name);
        save();
        renderWhitelist();
        showAlert(`已从白名单移出「${name}」`);
      };
    });
  }

  function addWhitelist() {
    const input = $('#wlInput');
    if (!input) return;
    const name = input.value.trim();
    if (!name) { showAlert('请输入姓名', true); return; }
    if (!state.originalOwners) state.originalOwners = [];
    if (state.originalOwners.indexOf(name) !== -1) { showAlert(`「${name}」已在白名单中`); return; }
    state.originalOwners.push(name);
    input.value = '';
    save();
    renderWhitelist();
    showAlert(`✅ 已添加「${name}」到白名单`);
  }

  function resetWhitelist() {
    if (!confirm('恢复默认白名单（唐朝汉/王东鸿/詹泉宏/胡宁/熊乘风）？当前名单将被覆盖。')) return;
    state.originalOwners = Engine.DEFAULT_ORIGINAL_OWNERS.slice();
    save();
    renderWhitelist();
    showAlert('✅ 已恢复默认白名单');
  }

  function renamePerson(idx) {
    const oldName = state.people[idx];
    const newName = prompt('输入新姓名：', oldName);
    if (newName == null) return;
    const r = Engine.renamePerson(state, oldName, newName.trim());
    if (!r.ok) { showAlert(r.error, true); return; }
    save(); renderAll(); showAlert(`✅ 已重命名：${oldName} → ${newName.trim()}`);
  }

  function removePerson(idx) {
    const name = state.people[idx];
    if (!confirm(`确定删除人员「${name}」？`)) return;
    const r = Engine.removePerson(state, name);
    if (!r.ok) { showAlert(r.error, true); return; }
    save(); renderAll(); showAlert(`已删除人员：${name}`);
  }

  // ---------- 登录记录 ----------
  let loginRecords = [];

  async function loadLoginRecords() {
    try {
      const res = await fetch('/api/login-records', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) { window.location.href = '/login.html'; return; }
      if (!res.ok) { showAlert('加载登录记录失败', true); return; }
      const data = await res.json();
      loginRecords = (data && data.records) || [];
      renderLoginRecords();
    } catch (e) {
      showAlert('服务器不可用，无法加载登录记录', true);
    }
  }

  function renderLoginRecords() {
    const kw = ($('#loginSearch') ? $('#loginSearch').value : '').trim().toLowerCase();
    const list = kw
      ? loginRecords.filter((r) => (r.ip || '').toLowerCase().indexOf(kw) !== -1
          || (r.user || '').toLowerCase().indexOf(kw) !== -1
          || (r.device || '').toLowerCase().indexOf(kw) !== -1
          || (r.browser || '').toLowerCase().indexOf(kw) !== -1)
      : loginRecords;
    $('#loginInfo').innerHTML = `共 <b>${list.length}</b> 条${kw ? `（搜索"${kw}"）` : ''}`;
    const tbody = $('#loginTbody');
    if (!list.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">暂无登录记录</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((r) => `
      <tr>
        <td>${escapeHtml(r.time || '—')}</td>
        <td><b>${escapeHtml(r.ip || '—')}</b></td>
        <td>${escapeHtml(r.device || '—')}</td>
        <td>${escapeHtml(r.browser || '—')}</td>
        <td>${escapeHtml(r.user || '—')}</td>
        <td>${r.result === '成功' ? '<span class="status-tag st-3">成功</span>' : '<span class="status-tag st-2">失败</span>'}</td>
        <td class="col-desc" title="${escapeHtml(r.ua || '')}">${escapeHtml(r.ua || '—')}</td>
      </tr>`).join('');
  }

  // ---------- 更新日志（后端 API 拉取，只读） ----------
  async function loadChangelog() {
    try {
      const res = await fetch('/api/changelog', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json();
      if (data.ok && Array.isArray(data.changelog)) CHANGELOG = data.changelog;
    } catch (e) {
      console.warn('[changelog] 拉取失败', e);
    }
  }

  async function renderChangelog() {
    if (!CHANGELOG.length) await loadChangelog();
    $('#changelogBody').innerHTML = CHANGELOG.map((c) => `
      <div style="margin-bottom:14px">
        <div style="font-weight:700;color:#e85418;font-size:13px">v${c.ver} <span style="color:#989898;font-weight:400;font-size:11px">${escapeHtml(c.date || '')}${c.source_ip && c.source_ip !== '—' ? ' · 来源 ' + escapeHtml(c.source_ip) : ''}</span></div>
        <ul style="margin:6px 0 0 18px;font-size:12px;color:#484848;line-height:1.9">${(c.items || []).map((i) => `<li>${i}</li>`).join('')}</ul>
      </div>`).join('');
  }

  // ---------- 版本管理（仅管理员：备份列表 + 一键回滚） ----------
  async function createBackupNow() {
    const btn = $('#btnBackupNow');
    if (!btn) return;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '⏳ 备份中…';
    try {
      const res = await fetch('/api/backup/create', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.ok) {
        alert('✅ ' + data.message);
        loadBackupView();
      } else {
        alert('❌ ' + (data.error || '备份失败'));
      }
    } catch (e) {
      alert('❌ 请求失败：' + String(e));
    }
    btn.disabled = false;
    btn.textContent = oldText;
  }

  async function loadBackupView() {
    const box = $('#backupList');
    if (!box) return;
    box.innerHTML = '<div style="padding:20px;color:#787878">⏳ 加载备份列表…</div>';
    try {
      const res = await fetch('/api/backups', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json();
      if (!data.ok) {
        box.innerHTML = `<div style="padding:20px;color:#c0392b">${escapeHtml(data.error || '加载失败')}</div>`;
        return;
      }
      const keep = data.keep_days || 7;
      const hint = data.backups.length
        ? `共 ${data.backups.length} 份备份 · 自动保留最近 ${keep} 天，超过自动清理 · 回滚前自动备份当前版本`
        : `暂无备份。服务启动时检测到代码变更会自动备份，或点击上方「立即备份」手动备份（保留最近 ${keep} 天）`;
      box.innerHTML = `
        <div class="list-toolbar" style="margin-bottom:10px">
          <div style="font-size:12px;color:#787878">${hint}</div>
          <div class="list-tools">
            <button class="btn btn-sm btn-primary" id="btnBackupNow" onclick="window.__bugtrackerBackupNow()">📦 立即备份当前版本</button>
          </div>
        </div>
        <table class="data-table" id="backupTable">
          <thead><tr>
            <th>备份时间</th><th>版本号</th><th>类型</th><th>大小</th><th>来源 IP</th><th>操作</th>
          </tr></thead>
          <tbody>${data.backups.map((b) => `
            <tr>
              <td>${escapeHtml(b.time)}</td>
              <td><b style="color:#e85418">v${escapeHtml(b.version || '?')}</b></td>
              <td>${b.reason === 'auto' ? '<span class="status-tag st-3">自动备份</span>' : (b.reason === 'rollback' ? '<span class="status-tag st-2">回滚前保护</span>' : '<span class="status-tag">手动备份</span>')}</td>
              <td>${(b.size / 1024).toFixed(0)} KB</td>
              <td>${escapeHtml(b.source_ip || '—')}</td>
              <td><button class="btn btn-sm btn-plain" onclick="window.__bugtrackerRollback('${b.id}','${escapeHtml(b.time)}','${escapeHtml(b.version || '')}')">↩️ 回滚到此版本</button></td>
            </tr>`).join('')}</tbody>
        </table>`;
    } catch (e) {
      box.innerHTML = '<div style="padding:20px;color:#c0392b">加载失败：' + escapeHtml(String(e)) + '</div>';
    }
  }
  window.__bugtrackerBackupNow = createBackupNow;   // 供「立即备份」按钮调用

  /** 回滚二次确认：弹窗展示目标备份信息（版本号/时间），用户确认后才调用后端（后端同样要求 confirm=true） */
  function confirmRollback(backupId, backupTime, backupVersion) {
    const mask = $('#rollbackModal');
    if (!mask) return;
    $('#rollbackTarget').innerHTML = `目标版本：<b style="color:#e85418">v${escapeHtml(backupVersion || '?')}</b><br>备份时间：<b>${escapeHtml(backupTime)}</b><br>备份文件：<code>${escapeHtml(backupId)}</code>`;
    $('#rollbackStatus').textContent = '';
    mask.classList.remove('hidden');
    const btn = $('#btnRollbackOk');
    const doIt = async () => {
      btn.disabled = true;
      $('#rollbackStatus').textContent = '⏳ 正在回滚（回滚前会自动备份当前版本）…';
      try {
        const res = await fetch('/api/backup/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ id: backupId, confirm: true }),
        });
        const data = await res.json();
        if (data.ok) {
          $('#rollbackStatus').innerHTML = '<span style="color:#45bf82">✅ ' + escapeHtml(data.message) + '</span>';
          setTimeout(() => { mask.classList.add('hidden'); loadBackupView(); }, 2500);
        } else {
          $('#rollbackStatus').innerHTML = '<span style="color:#c0392b">❌ ' + escapeHtml(data.error || '回滚失败') + '</span>';
          btn.disabled = false;
        }
      } catch (e) {
        $('#rollbackStatus').innerHTML = '<span style="color:#c0392b">❌ 请求失败：' + escapeHtml(String(e)) + '</span>';
        btn.disabled = false;
      }
    };
    btn.onclick = doIt;
  }
  window.__bugtrackerRollback = confirmRollback;   // 供表格按钮调用（冒烟测试亦可用）

  // ---------- 初始化 ----------
  function init() {
    // 版本
    $$('.version-tag').forEach((el) => el.textContent = 'v' + APP_VERSION);
    $('#footerVersion').textContent = 'v' + APP_VERSION;
    // 版本统计卡片拖拽排序（一次性绑定，重渲染不重复注册）
    bindVerDrag();

    // 导航
    $$('.nav-item').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));

    // 模态框关闭
    $$('[data-close]').forEach((el) => el.addEventListener('click', () => $('#' + el.dataset.close).classList.add('hidden')));
    $$('.modal-mask').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));
    // ESC 关闭当前打开的弹窗（含 BUG 详细信息）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = $$('.modal-mask').filter((m) => !m.classList.contains('hidden'));
      if (open.length) open[open.length - 1].classList.add('hidden');
    });

    // 版本号 → 更新日志（异步拉取后端 changelog，预热避免首次点击空白）
    loadChangelog();
    $('#versionTag').addEventListener('click', renderChangelog);
    $('#versionTag').addEventListener('click', () => $('#changelogModal').classList.remove('hidden'));

    // 编号异常明细弹窗（v1.40.0）
    $('#abnormalTag').addEventListener('click', () => {
      const list = Engine.findAbnormalIds(state);
      const body = $('#abnormalBody');
      if (!list.length) {
        body.innerHTML = '<div style="color:#989898;font-size:12px;padding:8px 0">暂无编号异常记录</div>';
      } else {
        body.innerHTML = `<div style="font-size:12px;color:#787878;margin-bottom:8px">共 <b style="color:#d64545">${list.length}</b> 条编号不匹配 BUG+8位日期+序号 格式（按月统计时按首次导入时间归月）</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <tr style="background:#f8f0ec;color:#484848">
              <th style="padding:6px 8px;text-align:left;border:1px solid #eee">编号</th>
              <th style="padding:6px 8px;text-align:left;border:1px solid #eee">标题</th>
              <th style="padding:6px 8px;text-align:left;border:1px solid #eee">发现发布</th>
              <th style="padding:6px 8px;text-align:left;border:1px solid #eee">状态</th>
              <th style="padding:6px 8px;text-align:left;border:1px solid #eee">首次导入</th>
            </tr>
            ${list.map((r) => `<tr>
              <td style="padding:6px 8px;border:1px solid #eee;color:#d64545;white-space:nowrap">${escapeHtml(r.no)}</td>
              <td style="padding:6px 8px;border:1px solid #eee;color:#484848">${escapeHtml(r.title)}</td>
              <td style="padding:6px 8px;border:1px solid #eee;white-space:nowrap">${escapeHtml(r.version)}</td>
              <td style="padding:6px 8px;border:1px solid #eee;white-space:nowrap">${escapeHtml(r.status)}</td>
              <td style="padding:6px 8px;border:1px solid #eee;white-space:nowrap">${r.firstSeenAt ? escapeHtml(String(r.firstSeenAt).slice(0, 10)) : '-'}</td>
            </tr>`).join('')}
          </table>`;
      }
      $('#abnormalModal').classList.remove('hidden');
    });

    // 版本管理：回滚二次确认弹窗按钮
    $('#btnRollbackCancel').addEventListener('click', () => $('#rollbackModal').classList.add('hidden'));

    // 导入视图
    initImportView();

    // 看板统计项点击筛选已在 renderBarStats 内绑定

    // 趋势天数选择
    $('#trendDays').addEventListener('change', (e) => {
      state.trendDays = parseInt(e.target.value, 10) || 7;
      save();
      renderTrend(getVerList());
    });

    // 按月统计月份筛选（v1.37.0）
    $('#monthFilter').addEventListener('change', () => {
      renderMonthStats(getVerList());
    });

    // 版本多选：点击外部关闭弹层
    document.addEventListener('click', (e) => {
      const wrap = $('#verMultiWrap');
      if (wrap && !wrap.contains(e.target)) {
        const pop = $('#verMultiPop');
        if (pop) pop.classList.add('hidden');
      }
    });

    // 导出问题清单（按当前版本筛选 + 责任人分组）
    $('#btnExportBugList').addEventListener('click', exportBugList);
    // 导出当前列表（版本-姓名 分组）：人员/版本维度
    $('#btnExportVerOwner').addEventListener('click', exportVerOwnerList);
    $('#btnExportDimOwner').addEventListener('click', () => doExportVerOwner('owner'));
    $('#btnExportDimVersion').addEventListener('click', () => doExportVerOwner('version'));

    // 列表工具
    $('#quickSearch').addEventListener('input', (e) => { quickSearch = e.target.value.trim(); renderList(); });
    $('#btnTodayNew').addEventListener('click', () => {
      if (activeFilters.__todayNew) delete activeFilters.__todayNew;
      else activeFilters.__todayNew = { type: 'todayNew', value: true };
      renderList();
    });
    $('#btnClearFilters').addEventListener('click', () => { activeFilters = {}; quickSearch = ''; $('#quickSearch').value = ''; renderList(); });
    // 复制编号整列：复制当前列表（含筛选/搜索）全部编号，每行一个
    $('#btnCopyIds').addEventListener('click', () => {
      const recs = getFilteredRecords();
      if (!recs.length) { showAlert('当前列表无数据可复制', true); return; }
      const text = recs.map((r) => String(r.fields['编号'] || r.id || '')).join('\n');
      copyText(text, `已复制 ${recs.length} 个编号`);
    });
    $('#btnExportFiltered').addEventListener('click', exportCurrentCsv);

    // 人员
    $('#btnAddPerson').addEventListener('click', () => {
      const input = $('#newPersonName');
      const name = input.value.trim();
      if (!name) { showAlert('请输入姓名', true); return; }
      const r = Engine.addPerson(state, name);
      if (!r.ok) { showAlert(r.error, true); return; }
      input.value = '';
      save(); renderPeople(); renderNavCounts(); showAlert(`✅ 已添加人员：${name}`);
    });
    $('#newPersonName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAddPerson').click(); });

    // 白名单
    $('#btnAddWhitelist').addEventListener('click', addWhitelist);
    $('#wlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWhitelist(); });
    $('#btnResetWhitelist').addEventListener('click', resetWhitelist);

    // 登录记录
    $('#btnRefreshLogin').addEventListener('click', loadLoginRecords);
    $('#loginSearch').addEventListener('input', () => renderLoginRecords());

    // 改派确认
    $('#btnReassignOk').addEventListener('click', confirmReassign);
    initReassignSearch();
    // 备注确认
    $('#btnNoteOk').addEventListener('click', confirmNote);
    // 删除确认
    $('#btnDeleteOk').addEventListener('click', confirmDeleteBug);
    // 详情弹窗快捷操作（关闭详情后打开对应弹窗）
    $('#dtBtnReassign').addEventListener('click', () => {
      const id = $('#detailModal').dataset.id;
      if (!id) return;
      $('#detailModal').classList.add('hidden');
      openReassign(id);
    });
    $('#dtBtnNote').addEventListener('click', () => {
      const id = $('#detailModal').dataset.id;
      if (!id) return;
      $('#detailModal').classList.add('hidden');
      openNote(id);
    });
    $('#dtBtnHistory').addEventListener('click', () => {
      const id = $('#detailModal').dataset.id;
      if (!id) return;
      $('#detailModal').classList.add('hidden');
      openHistory(id);
    });
    $('#dtBtnDelete').addEventListener('click', () => {
      const id = $('#detailModal').dataset.id;
      if (!id) return;
      $('#detailModal').classList.add('hidden');
      openDeleteBug(id);
    });
    // 详情弹窗标题：点击编号复制（v1.32.4）
    $('#dtModalId').addEventListener('click', () => {
      const id = $('#dtModalId').textContent;
      if (!id || id === '✓ 已复制') return;
      const done = () => {
        const el = $('#dtModalId');
        el.textContent = '✓ 已复制';
        setTimeout(() => { el.textContent = id; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).then(done).catch(() => fallbackCopyText(id, done));
      } else {
        fallbackCopyText(id, done);
      }
    });
    // 问题统计弹窗（v1.33.0）
    $('#btnStatsModal').addEventListener('click', openStatsModal);
    $('#btnStatsCopy').addEventListener('click', () => {
      const text = $('#statsText').textContent;
      const done = () => {
        const btn = $('#btnStatsCopy');
        const old = btn.textContent;
        btn.textContent = '✅ 已复制';
        setTimeout(() => { btn.textContent = old; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopyText(text, done));
      } else {
        fallbackCopyText(text, done);
      }
    });
    // 恢复确认
    $('#btnRestoreOk').addEventListener('click', confirmRestore);

    // 点击空白关闭筛选弹层
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#filterPop') && !e.target.closest('.f-icon')) {
        $('#filterPop').classList.add('hidden');
      }
    });

    renderAll();
    // 角色权限（本地缓存角色立即生效；/api/me 返回后刷新）
    applyRolePermission();
    bindUserTag();
    // 服务器共享同步（异步，不阻塞首屏）
    initRemoteSync();
    // 获取当前登录用户（备注/删除操作人记录）
    fetchCurrentUser();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
