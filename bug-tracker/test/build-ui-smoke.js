#!/usr/bin/env node
/**
 * 生成 UI 冒烟测试页：index.html + 预置数据 + 断言脚本
 * 运行：node test/build-ui-smoke.js && chrome --headless --dump-dom test/ui.smoke.html
 */
const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const testScript = `
<script>
const E = window.BugEngine, S = window.BugStorage;
const state = E.emptyState('1.0.0');
const mk = (o) => Object.assign({
  '编号':'','标题':'t','描述':'','状态':'新建','发现发布':'V1.0','分析原因':'',
  '停留天数':'0','严重程度':'一般','当前责任人':'张伟','最近修改时间':'','创建人':'',
  '退回原因':'','激活原因':'','最近更新人':''
}, o);
// 预置数据用动态日期（v1.35.1 起「今日新增/解决」按运行当天统计，写死日期会导致冒烟过期失败）：
// 昨天导入基线 → 今天导入一次（新增 B4、解决 B2），今日累计 = 本次导入结果
const D = new Date();
const today = D.getFullYear() + '-' + String(D.getMonth() + 1).padStart(2, '0') + '-' + String(D.getDate()).padStart(2, '0');
const yesterday = new Date(D.getTime() - 86400000);
const yKey = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
E.applyImport(state, [
  mk({'编号':'B1','标题':'登录失败','描述':'这是一段超长的描述内容，用于验证鼠标悬停时能否完整显示全部描述信息，超过一定长度后应该被省略号截断显示','状态':'新建','发现发布':'V1.0','严重程度':'严重','停留天数':'6','当前责任人':'张伟'}),
  mk({'编号':'B2','标题':'导出乱码','状态':'处理中','发现发布':'V1.0','严重程度':'一般','停留天数':'2','当前责任人':'李娜'}),
  mk({'编号':'B3','标题':'支付超时','状态':'新建','发现发布':'V2.0','严重程度':'严重','停留天数':'9','当前责任人':'张伟'})
], yKey + 'T09:00:00');
E.applyImport(state, [
  mk({'编号':'B1','标题':'登录失败','描述':'这是一段超长的描述内容，用于验证鼠标悬停时能否完整显示全部描述信息，超过一定长度后应该被省略号截断显示','状态':'处理中','发现发布':'V1.0','严重程度':'严重','停留天数':'7','当前责任人':'王强'}),
  mk({'编号':'B3','标题':'支付超时','状态':'处理中','发现发布':'V2.0','严重程度':'严重','停留天数':'10','当前责任人':'张伟'}),
  mk({'编号':'B4','标题':'新BUG-按钮无效','状态':'新建','发现发布':'V2.0','严重程度':'轻微','停留天数':'0','当前责任人':'赵敏'})
], today + 'T09:00:00');
localStorage.setItem(S.STATE_KEY, JSON.stringify(state));
localStorage.setItem(S.META_KEY, JSON.stringify({}));
localStorage.setItem('bugtracker:role', 'admin');  // 冒烟默认管理员角色（导入页可见）
</script>
<script src="../js/app.js"></script>
<script>
const results = [];
function check(name, cond) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name); }
setTimeout(() => {
  // 几何可见性辅助：元素真实渲染且占位（防 CSS 裁切/隐藏回归——textContent 查不到视觉问题）
  const vis = (el) => !!el && el.offsetWidth > 0 && el.offsetHeight > 0 && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  try {
    // 0. 核心 UI 几何可见性（改动后必须保持）
    check('导航栏 6 项全部可见（admin 角色含版本管理）', document.querySelectorAll('.nav-item').length === 6 && Array.from(document.querySelectorAll('.nav-item')).every((i) => vis(i)));
    check('切换账号入口存在（顶栏 userTag）', !!document.querySelector('#userTag'));
    // 0.1 角色权限（v1.27.0 + v1.34.0）：admin 可见导入页/版本管理；user 隐藏
    check('管理员角色：导入导航可见', document.querySelector('.nav-item[data-view="import"]').style.display !== 'none' && vis(document.querySelector('.nav-item[data-view="import"]')));
    check('管理员角色：版本管理导航可见', document.querySelector('.nav-item[data-view="versions"]').style.display !== 'none' && vis(document.querySelector('.nav-item[data-view="versions"]')));
    window.__bugtrackerApplyRole('user');
    check('普通用户：导入导航隐藏', document.querySelector('.nav-item[data-view="import"]').style.display === 'none');
    check('普通用户：版本管理导航隐藏', document.querySelector('.nav-item[data-view="versions"]').style.display === 'none');
    window.__bugtrackerApplyRole('admin');
    check('切回管理员：导入导航恢复', document.querySelector('.nav-item[data-view="import"]').style.display !== 'none');
    check('统计卡片 5 张全部可见', document.querySelectorAll('#statCards .card').length === 5 && Array.from(document.querySelectorAll('#statCards .card')).every((c) => vis(c)));
    check('版本统计条全部可见', Array.from(document.querySelectorAll('#verStats .stat-item')).every((i) => vis(i)));
    check('严重程度统计全部可见', Array.from(document.querySelectorAll('#sevStats .stat-item')).every((i) => vis(i)));
    check('责任人维度全部可见', Array.from(document.querySelectorAll('#ownerStats .person-row')).every((r) => vis(r)));
    check('趋势图可见（' + (document.querySelector('#trendChart canvas') ? document.querySelector('#trendChart canvas').offsetWidth + 'x' + document.querySelector('#trendChart canvas').offsetHeight : '无canvas') + '）', vis(document.querySelector('#trendChart canvas')));
    check('导航未解决数 = 3', document.querySelector('#navListCnt').textContent.trim() === '3');
    const cards = Array.from(document.querySelectorAll('#statCards .card .value')).map(v => v.textContent.trim());
    check('今日新增 = 1', cards[0] === '1');
    check('今日解决 = 1', cards[1] === '1');
    check('未解决总数 = 3', cards[2] === '3');
    check('停留超期 = 2', cards[3] === '2');
    check('累计问题 = 4（含已解决 B2）', cards[4] === '4');
    check('累计问题 delta 已修复 1', document.querySelectorAll('#statCards .card .delta')[4].textContent.indexOf('已修复 1') !== -1);
    const verText = Array.from(document.querySelectorAll('#verStats .stat-item')).map(i => i.textContent.replace(/\\s+/g,'')).join('|');
    check('版本统计 V1.0 存在', verText.indexOf('V1.0') !== -1);
    check('版本统计 V2.0=2', /V2\\.0[^|]*2/.test(verText));
    // v1.27.0 口径统一：版本卡总和 = 严重程度卡总和 = 未解决总数（同源校验）
    const verSum = Array.from(document.querySelectorAll('#verStats .stat-item .num')).reduce((a, el) => a + parseInt(el.textContent, 10), 0);
    const sevSum = Array.from(document.querySelectorAll('#sevStats .stat-item .num')).reduce((a, el) => a + parseInt(el.textContent, 10), 0);
    const activeCnt = parseInt(document.querySelectorAll('#statCards .card .value')[2].textContent.trim(), 10);
    check('版本卡总和 = 严重程度卡总和', verSum === sevSum);
    check('版本卡总和 = 未解决总数', verSum === activeCnt);
    check('严重程度 2 项(严重/轻微)', document.querySelectorAll('#sevStats .stat-item').length === 2);
    check('责任人维度 3 人', document.querySelectorAll('#ownerStats .person-row').length === 3);
    check('趋势图 canvas 渲染', !!document.querySelector('#trendChart canvas'));
    document.querySelector('.nav-item[data-view="list"]').click();
    check('列表显示 3 行', document.querySelectorAll('#bugTbody tr').length === 3);
    check('列表行含上次责任人(王强)', document.querySelector('#bugTbody tr').textContent.indexOf('王强') !== -1);
    // v1.36.1：今日新增快捷筛选（今天导入新增的 B4，firstSeenAt=今天）
    const tnBtn = document.querySelector('#btnTodayNew');
    check('今日新增按钮存在', !!tnBtn);
    tnBtn.click();
    check('今日新增筛选 = 1 条（B4）', document.querySelector('#filterInfo b').textContent.trim() === '1');
    check('今日新增按钮高亮', tnBtn.classList.contains('has-filter'));
    tnBtn.click();
    check('取消今日新增筛选恢复 3 条', document.querySelector('#filterInfo b').textContent.trim() === '3');
    document.querySelector('#bugThead .f-icon[data-col="严重程度"]').click();
    const pop = document.querySelector('#filterPop');
    check('筛选弹层可见', vis(pop));
    // v1.41.0：枚举多选支持全选/清空
    check('全选按钮存在', !!document.querySelector('#fpSelAll'));
    check('清空按钮存在', !!document.querySelector('#fpSelNone'));
    document.querySelector('#fpSelAll').click();
    check('点击全选 → 全部勾选', document.querySelectorAll('#filterPop .filter-opts input:checked').length === document.querySelectorAll('#filterPop .filter-opts input').length);
    document.querySelector('#fpOk').click();
    check('全选确定 → 该列不过滤（3 行）', document.querySelectorAll('#bugTbody tr').length === 3);
    check('全选后无冗余筛选提示', document.querySelector('#btnClearFilters').textContent === '清除筛选');
    document.querySelector('#bugThead .f-icon[data-col="严重程度"]').click();
    const cbPre = Array.from(pop.querySelectorAll('input[type=checkbox]')).find(i => i.value === '严重');
    if (cbPre) cbPre.checked = true;
    document.querySelector('#fpSelNone').click();
    check('勾选后点清空 → 全部取消', document.querySelectorAll('#filterPop .filter-opts input:checked').length === 0);
    document.querySelector('#fpOk').click();
    check('清空确定 → 该列不过滤（3 行）', document.querySelectorAll('#bugTbody tr').length === 3);
    document.querySelector('#bugThead .f-icon[data-col="严重程度"]').click();
    const cb = Array.from(pop.querySelectorAll('input[type=checkbox]')).find(i => i.value === '严重');
    if (cb) { cb.checked = true; document.querySelector('#fpOk').click(); }
    check('筛选严重 → 2 行', document.querySelectorAll('#bugTbody tr').length === 2);
    check('清除筛选按钮高亮+显示列数', document.querySelector('#btnClearFilters').classList.contains('has-filter') && document.querySelector('#btnClearFilters').textContent === '清除筛选(1)');
    check('筛选弹层含清除全部按钮', !!document.querySelector('#fpClearAll'));
    // 弹层「清除全部」：再筛一列后一键全清
    document.querySelector('#bugThead .f-icon[data-col="当前责任人"]').click();
    const cb2 = Array.from(document.querySelectorAll('#filterPop input[type=checkbox]')).find(i => i.value === '张伟');
    if (cb2) { cb2.checked = true; document.querySelector('#fpOk').click(); }
    check('两列筛选后 1 行（B1 责任人已被导入改为王强）', document.querySelectorAll('#bugTbody tr').length === 1);
    check('清除筛选按钮显示(2)', document.querySelector('#btnClearFilters').textContent === '清除筛选(2)');
    document.querySelector('#bugThead .f-icon[data-col="严重程度"]').click();
    document.querySelector('#fpClearAll').click();
    check('弹层清除全部 → 恢复 3 行', document.querySelectorAll('#bugTbody tr').length === 3);
    document.querySelector('#btnClearFilters').click();
    check('清除筛选 → 3 行', document.querySelectorAll('#bugTbody tr').length === 3);
    // 复制编号整列
    let copiedText = '';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (t) => { copiedText = t; return Promise.resolve(); } },
        configurable: true
      });
    } catch (e) {
      navigator.clipboard = { writeText: (t) => { copiedText = t; return Promise.resolve(); } };
    }
    document.querySelector('#btnCopyIds').click();
    check('复制编号整列 3 个（每行一个）', copiedText.split('\\n').length === 3 && copiedText.indexOf('B1') !== -1 && copiedText.indexOf('B3') !== -1);
    document.querySelector('.nav-item[data-view="people"]').click();
    check('人员名单 4 人', document.querySelectorAll('#peopleTbody tr').length === 4);
    check('人员表可见', vis(document.querySelector('#peopleTable')));
    check('白名单标签可见', Array.from(document.querySelectorAll('#whitelistTags .wl-tag')).every((t) => vis(t)));
    // 白名单管理（v1.15.0）
    check('白名单默认 5 人', document.querySelectorAll('#whitelistTags .wl-tag').length === 5);
    check('白名单含唐朝汉', document.querySelector('#whitelistTags').textContent.indexOf('唐朝汉') !== -1);
    const wlInput = document.querySelector('#wlInput');
    wlInput.value = '测试人';
    document.querySelector('#btnAddWhitelist').click();
    check('添加白名单后 6 人', document.querySelectorAll('#whitelistTags .wl-tag').length === 6);
    const testTag = Array.from(document.querySelectorAll('#whitelistTags .x')).find(el => decodeURIComponent(el.dataset.wl) === '测试人');
    check('新成员标签可移出', !!testTag);
    if (testTag) testTag.click();
    check('移出后恢复 5 人', document.querySelectorAll('#whitelistTags .wl-tag').length === 5);
    window.confirm = () => true;
    document.querySelector('#btnResetWhitelist').click();
    check('恢复默认后 5 人且含唐朝汉', document.querySelectorAll('#whitelistTags .wl-tag').length === 5 && document.querySelector('#whitelistTags').textContent.indexOf('唐朝汉') !== -1);
    check('版本号与页头一致', document.querySelector('#footerVersion').textContent.trim() === document.querySelector('.version-tag').textContent.trim());
    // 13. 趋势天数选择器存在且可切换
    const trendSel = document.querySelector('#trendDays');
    check('趋势天数选择器存在', !!trendSel);
    check('趋势默认 7 天', trendSel.value === '7');
    trendSel.value = '30';
    trendSel.dispatchEvent(new Event('change'));
    check('切换 30 天后趋势仍渲染', !!document.querySelector('#trendChart canvas'));
    // 14. 描述列 hover 显示完整内容（title 属性）
    document.querySelector('.nav-item[data-view="list"]').click();
    document.querySelector('#btnClearFilters').click();
    const descCell = document.querySelector('#bugTbody .col-desc');
    check('描述列有悬停提示', !!descCell && descCell.getAttribute('title') !== null && descCell.getAttribute('title') !== '');
    // 15. 数据清零按钮存在 + 弹窗打开
    document.querySelector('.nav-item[data-view="import"]').click();
    check('数据清零按钮存在', !!document.querySelector('#btnClearData'));
    document.querySelector('#btnClearData').click();
    check('清零确认弹窗打开', !document.querySelector('#clearModal').classList.contains('hidden'));
    check('清零弹窗可见', vis(document.querySelector('#clearModal')));
    check('清零弹窗显示数据概况', document.querySelector('#clearSummary').textContent.indexOf('BUG 记录') !== -1);
    check('清零二次确认输入框存在', !!document.querySelector('#clearConfirmInput'));
    check('清零按钮初始禁用', document.querySelector('#btnClearOk').disabled === true);
    const ci = document.querySelector('#clearConfirmInput');
    ci.value = '确认';
    ci.dispatchEvent(new Event('input'));
    check('输入「确认」后按钮启用', document.querySelector('#btnClearOk').disabled === false);
    document.querySelector('#clearModal .modal-close').click();
    check('清零弹窗可关闭', document.querySelector('#clearModal').classList.contains('hidden'));
    // 16. 看板版本多选筛选（顶部按钮 + 弹层）
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    const verBtn = document.querySelector('#btnVerMulti');
    check('版本多选按钮存在', !!verBtn);
    check('多选按钮默认显示全部版本', verBtn.textContent.indexOf('全部版本') !== -1);
    // 打开弹层验证版本列表
    verBtn.click();
    const verOpts = Array.from(document.querySelectorAll('#verMultiList input')).map(i => i.value);
    check('多选列表含 V1.0', verOpts.indexOf('V1.0') !== -1);
    check('多选列表含 V2.0', verOpts.indexOf('V2.0') !== -1);
    // 勾选 V1.0 确定 → 未解决总数 1（只有 B1）
    document.querySelectorAll('#verMultiList input').forEach(cb => { if (cb.value === 'V1.0') cb.checked = true; });
    document.querySelector('#btnVerApply').click();
    const cardsV1 = Array.from(document.querySelectorAll('#statCards .card .value')).map(v => v.textContent.trim());
    check('筛选V1.0后未解决总数=1', cardsV1[2] === '1');
    check('筛选V1.0后累计问题=2（B1+B2）', cardsV1[4] === '2');
    check('筛选V1.0后累计已修复 1', document.querySelectorAll('#statCards .card .delta')[4].textContent.indexOf('已修复 1') !== -1);
    check('筛选V1.0后严重程度只有严重(1项)', document.querySelectorAll('#sevStats .stat-item').length === 1);
    // 清空
    document.querySelector('#btnShowAllVers').click();
    const cardsAll = Array.from(document.querySelectorAll('#statCards .card .value')).map(v => v.textContent.trim());
    check('切回全部后未解决总数=3', cardsAll[2] === '3');
    // 17. 版本面板点击版本号 → 看板内多选筛选（不跳列表）
    const verItemV1 = Array.from(document.querySelectorAll('#verStats .stat-item')).find(i => i.dataset.col === 'V1.0');
    check('版本面板含 V1.0 行', !!verItemV1);
    check('全部版本为标题链接(不在列表中)', !document.querySelector('#verStats [data-col="__ALL__"]') && !!document.querySelector('#btnShowAllVers'));
    verItemV1.click();
    const cardsAfterClick = Array.from(document.querySelectorAll('#statCards .card .value')).map(v => v.textContent.trim());
    check('点击版本号后看板切换为 V1.0(未解决=1)', cardsAfterClick[2] === '1');
    check('点击版本号未跳转列表视图', document.querySelector('#view-dashboard').style.display !== 'none');
    check('选中版本行高亮', !!document.querySelector('#verStats .stat-item[data-col="V1.0"]').getAttribute('style'));
    check('全部版本链接激活', document.querySelector('#btnShowAllVers').classList.contains('active'));
    // 多选：再点 V2.0 → 未解决=2
    const verItemV2 = Array.from(document.querySelectorAll('#verStats .stat-item')).find(i => i.dataset.col === 'V2.0');
    verItemV2.click();
    const cardsMulti = Array.from(document.querySelectorAll('#statCards .card .value')).map(v => v.textContent.trim());
    check('多选 V1.0+V2.0 未解决=3', cardsMulti[2] === '3');
    check('多选后 V1.0 V2.0 均高亮', document.querySelectorAll('#verStats .stat-item[style*="outline"]').length === 2);
    check('多选按钮显示已选2个', document.querySelector('#btnVerMulti').textContent.indexOf('已选 2') !== -1);
    // 点击"全部版本"链接恢复
    document.querySelector('#btnShowAllVers').click();
    const cardsAll2 = Array.from(document.querySelectorAll('#statCards .card .value')).map(v => v.textContent.trim());
    check('点击全部版本恢复(未解决=3)', cardsAll2[2] === '3');
    // 18. 顶部多选下拉
    document.querySelector('#btnVerMulti').click();
    check('多选弹层打开', !document.querySelector('#verMultiPop').classList.contains('hidden'));
    check('多选弹层可见', vis(document.querySelector('#verMultiPop')));
    check('多选列表含全部版本', document.querySelectorAll('#verMultiList input').length >= 2);
    // 勾选 V1.0 和 V2.0 确定
    const cbs = Array.from(document.querySelectorAll('#verMultiList input'));
    cbs.forEach(cb => { if (cb.value === 'V1.0' || cb.value === 'V2.0') cb.checked = true; });
    document.querySelector('#btnVerApply').click();
    const cardsPop = Array.from(document.querySelectorAll('#statCards .card .value')).map(v => v.textContent.trim());
    check('弹层多选后未解决=3', cardsPop[2] === '3');
    document.querySelector('#btnShowAllVers').click();
    // 19. 导出问题清单按钮
    check('导出问题清单按钮存在', !!document.querySelector('#btnExportBugList'));
    // 20. 改派搜索
    document.querySelector('.nav-item[data-view="list"]').click();
    document.querySelector('#bugTbody [data-act="reassign"]').click();
    check('改派搜索框存在', !!document.querySelector('#reassignSearch'));
    check('改派弹窗可见', vis(document.querySelector('#reassignModal')));
    check('改派下拉含人员选项', document.querySelectorAll('#reassignTarget option').length >= 2);
    const searchInput = document.querySelector('#reassignSearch');
    searchInput.value = '张伟';
    searchInput.dispatchEvent(new Event('input'));
    const filteredOpts = Array.from(document.querySelectorAll('#reassignTarget option')).map(o => o.value);
    check('搜索"张伟"过滤出1人', filteredOpts.length === 1 && filteredOpts[0] === '张伟');
    searchInput.value = '不存在的人';
    searchInput.dispatchEvent(new Event('input'));
    check('搜索无结果提示', document.querySelector('#reassignTarget option').value === '');
    document.querySelector('#reassignModal .modal-close').click();
    // 21. 编号多单号筛选（活跃 BUG：B1 B3 B4）
    document.querySelector('#bugThead .f-icon[data-col="编号"]').click();
    const idsInput = document.querySelector('#fpIds');
    check('编号筛选为多单号输入框', !!idsInput);
    idsInput.value = 'B1, B4';
    document.querySelector('#fpOk').click();
    const idsRows = Array.from(document.querySelectorAll('#bugTbody tr')).map(tr => tr.textContent);
    check('多单号筛选 B1,B4 → 2 行', document.querySelectorAll('#bugTbody tr').length === 2);
    check('筛选结果含 B1', idsRows.some(r => r.indexOf('B1') !== -1));
    check('筛选结果含 B4', idsRows.some(r => r.indexOf('B4') !== -1));
    document.querySelector('#btnClearFilters').click();
    check('清除编号筛选恢复', document.querySelectorAll('#bugTbody tr').length === 3);
    // 责任人维度点击 → 跳转列表并自动筛选（v1.15.0）
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    const zhangRow = Array.from(document.querySelectorAll('#ownerStats .person-row')).find(r => r.dataset.owner === encodeURIComponent('张伟'));
    check('责任人行存在', !!zhangRow);
    if (zhangRow) zhangRow.click();
    check('点击人员跳转列表并自动筛选（张伟 1 行）', document.querySelector('#view-list').style.display !== 'none' && document.querySelectorAll('#bugTbody tr').length === 1);
    check('筛选信息显示已筛选 1 列', document.querySelector('#filterInfo').textContent.indexOf('已筛选') !== -1);
    document.querySelector('#btnClearFilters').click();
    // 严重程度卡片点击 → 跳转列表筛选（v1.15.0）
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    const sevItem = Array.from(document.querySelectorAll('#sevStats .stat-item')).find(el => el.querySelector('.name').textContent.trim() === '严重');
    check('严重程度项存在', !!sevItem);
    if (sevItem) sevItem.click();
    check('点击严重程度跳转列表并筛选（严重 2 行）', document.querySelector('#view-list').style.display !== 'none' && document.querySelectorAll('#bugTbody tr').length === 2);
    check('严重程度筛选信息 1 列', document.querySelector('#filterInfo').textContent.indexOf('已筛选 1 列') !== -1);
    document.querySelector('#btnClearFilters').click();
    // 22. 行操作含 备注/删除 按钮（v1.16.0）
    const ops = document.querySelector('#bugTbody tr').textContent;
    check('行操作含备注按钮', ops.indexOf('备注') !== -1);
    check('行操作含删除按钮', ops.indexOf('删除') !== -1);
    // 22.1 备注弹窗打开/保存/标记
    const noteBtn = Array.from(document.querySelectorAll('#bugTbody [data-act="note"]'))[0];
    noteBtn.click();
    check('备注弹窗打开', !document.querySelector('#noteModal').classList.contains('hidden'));
    check('备注弹窗可见', vis(document.querySelector('#noteModal')));
    const noteInput = document.querySelector('#noteText');
    noteInput.value = '已定位根因，修复中';
    document.querySelector('#btnNoteOk').click();
    check('备注保存后弹窗关闭', document.querySelector('#noteModal').classList.contains('hidden'));
    check('列表行显示备注标记', document.querySelector('#bugTbody tr').textContent.indexOf('💬') !== -1);
    // 22.2 删除弹窗：原因必填校验 + 确认删除
    const delBtn = Array.from(document.querySelectorAll('#bugTbody [data-act="delete"]'))[0];
    delBtn.click();
    check('删除弹窗打开', !document.querySelector('#deleteModal').classList.contains('hidden'));
    check('删除弹窗可见', vis(document.querySelector('#deleteModal')));
    document.querySelector('#btnDeleteOk').click();
    check('空原因删除被拦截', !document.querySelector('#deleteModal').classList.contains('hidden'));
    document.querySelector('#delReason').value = '非本团队问题';
    document.querySelector('#btnDeleteOk').click();
    check('删除后弹窗关闭', document.querySelector('#deleteModal').classList.contains('hidden'));
    check('删除后行数减少', document.querySelectorAll('#bugTbody tr').length === 2);
    // 22.3 历史弹窗显示删除记录
    const hisBtn = Array.from(document.querySelectorAll('#bugTbody [data-act="history"]'))[0];
    hisBtn.click();
    check('历史弹窗打开', !document.querySelector('#historyModal').classList.contains('hidden'));
    check('历史弹窗可见', vis(document.querySelector('#historyModal')));
    check('历史弹窗显示导入更新记录（v1.27.0 字段明细）', document.querySelector('#historyBody').textContent.indexOf('导入更新') !== -1);
    document.querySelector('#historyModal .modal-close').click();
    // 23. BUG 表列宽拖拽（v1.27.0）
    document.querySelector('.nav-item[data-view="list"]').click();
    document.querySelector('#btnClearFilters').click();
    check('colgroup 列数 = 15（14 字段 + 操作列）', document.querySelectorAll('#bugColgroup col').length === 15);
    check('列宽拖拽手柄数量 = 14', document.querySelectorAll('#bugThead .th-resizer').length === 14);
    check('列顺序：编号后紧跟严重程度、当前责任人', document.querySelectorAll('#bugThead th')[2].textContent.indexOf('编号') !== -1 && document.querySelectorAll('#bugThead th')[3].textContent.indexOf('严重程度') !== -1 && document.querySelectorAll('#bugThead th')[4].textContent.indexOf('当前责任人') !== -1);
    check('默认无固定列宽（auto 布局）', document.querySelectorAll('#bugColgroup col')[2].style.width === '');
    check('操作列按钮全部可见', Array.from(document.querySelectorAll('#bugTbody tr:first-child td:last-child .op-link')).every(el => el.offsetWidth > 0 && el.offsetHeight > 0));
    check('操作列按钮数量 = 4', document.querySelectorAll('#bugTbody tr:first-child td:last-child .op-link').length === 4);
    const wrapRect0 = document.querySelector('.table-wrap').getBoundingClientRect();
    const opThRect0 = document.querySelector('#bugThead th:last-child').getBoundingClientRect();
    check('操作列表头在可视区域内', opThRect0.right <= wrapRect0.right + 1);
    // 模拟拖拽：编号列 +80px
    const rz = document.querySelector('#bugThead .th-resizer[data-col="编号"]');
    const rzRect = rz.getBoundingClientRect();
    const wBefore = Math.round(rz.parentElement.getBoundingClientRect().width);
    const startX = rzRect.left + rzRect.width / 2;
    rz.dispatchEvent(new MouseEvent('mousedown', { clientX: startX, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: startX + 80, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: startX + 80, bubbles: true, cancelable: true }));
    const wAfter = parseInt(document.querySelectorAll('#bugColgroup col')[2].style.width, 10);
    check('拖拽后编号列宽增加约80px', wAfter >= wBefore + 70 && wAfter <= wBefore + 90);
    const savedW = JSON.parse(localStorage.getItem('bugtracker:colwidths') || '{}');
    check('列宽已持久化 localStorage（saved=' + savedW['编号'] + ' after=' + wAfter + '）', Math.abs(savedW['编号'] - wAfter) <= 3);
    // 重渲染（切走再切回）宽度保持
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    document.querySelector('.nav-item[data-view="list"]').click();
    check('重渲染后编号列宽保持已保存值', document.querySelectorAll('#bugColgroup col')[2].style.width === savedW['编号'] + 'px');
    check('拖拽后操作列按钮仍全部可见', Array.from(document.querySelectorAll('#bugTbody tr:first-child td:last-child .op-link')).every(el => el.offsetWidth > 0 && el.offsetHeight > 0));
    // 手柄点击不冒泡到 th（防止触发责任人列排序）
    const sortTh = document.querySelector('#bugThead th[data-sort]');
    let thClicked = false;
    sortTh.addEventListener('click', () => { thClicked = true; });
    const rzSort = sortTh.querySelector('.th-resizer');
    rzSort.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    check('手柄点击不触发表头排序', thClicked === false);
    const sortMarkBefore = sortTh.querySelector('.sort-mark').textContent;
    check('责任人列排序标记未变化', sortMarkBefore === ' ⇅');
    // 24. 行点击选中 + 表头分隔线（v1.27.0）
    let rowsSel = document.querySelectorAll('#bugTbody tr[data-id]');
    rowsSel[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    check('点击行高亮选中', document.querySelector('#bugTbody tr.row-selected') !== null);
    rowsSel = document.querySelectorAll('#bugTbody tr[data-id]');
    rowsSel[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const selRow1 = document.querySelector('#bugTbody tr.row-selected');
    check('点击另一行切换选中', !!selRow1 && selRow1.dataset.id === rowsSel[1].dataset.id);
    selRow1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    check('再点同一行取消选中', document.querySelectorAll('#bugTbody tr.row-selected').length === 0);
    rowsSel = document.querySelectorAll('#bugTbody tr[data-id]');
    rowsSel[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const selRow2 = document.querySelector('#bugTbody tr.row-selected');
    check('选中行背景为高亮色', getComputedStyle(selRow2.querySelector('td')).backgroundColor === 'rgb(248, 232, 224)');
    const thBorderW = parseFloat(getComputedStyle(document.querySelector('#bugThead th')).borderRightWidth);
    check('表头列分隔线存在', thBorderW > 0);
    check('操作列表头无右分隔线', parseFloat(getComputedStyle(document.querySelector('#bugThead th:last-child')).borderRightWidth) === 0);
    check('选中行操作列同步高亮', getComputedStyle(selRow2.querySelector('td:last-child')).backgroundColor === 'rgb(248, 232, 224)');
    // 行内操作按钮点击不触发选中切换
    const curSelId = selRow2.dataset.id;
    rowsSel = document.querySelectorAll('#bugTbody tr[data-id]');
    const otherRow = Array.from(rowsSel).find((x) => x.dataset.id !== curSelId);
    otherRow.querySelector('[data-act="note"]').click();
    document.querySelector('#noteModal .modal-close').click();
    check('点击操作按钮不改变选中行', document.querySelector('#bugTbody tr.row-selected') !== null && document.querySelector('#bugTbody tr.row-selected').dataset.id === curSelId);
    // 拖选文本不触发选中 + 原地点击仍选中（v1.27.0 修复：不重渲染，可正常选择单元格文本）
    let dragSel = document.querySelector('#bugTbody tr.row-selected');
    if (dragSel) { dragSel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
    rowsSel = document.querySelectorAll('#bugTbody tr[data-id]');
    const dragRow = rowsSel[0];
    dragRow.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true }));
    dragRow.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 10, bubbles: true }));
    dragRow.dispatchEvent(new MouseEvent('mouseup', { clientX: 60, clientY: 10, bubbles: true }));
    dragRow.dispatchEvent(new MouseEvent('click', { clientX: 60, clientY: 10, bubbles: true, cancelable: true }));
    check('拖选文本不触发行选中', document.querySelectorAll('#bugTbody tr.row-selected').length === 0);
    dragRow.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true }));
    dragRow.dispatchEvent(new MouseEvent('mouseup', { clientX: 10, clientY: 10, bubbles: true }));
    dragRow.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    check('原地点击仍触发选中', document.querySelector('#bugTbody tr.row-selected') !== null);
    check('选中后单元格文本仍可选择（无 user-select 限制）', getComputedStyle(dragRow.querySelector('td')).userSelect !== 'none');
    // 25. 导入版本变更检测 + 手动修改版本（v1.27.0）
    const r23 = E.applyImport(state, [mk({'编号':'B1','标题':'登录失败','状态':'处理中','发现发布':'V3.0','严重程度':'严重','停留天数':'8','当前责任人':'张伟'})], '2026-08-15T09:00:00');
    check('导入检测版本变更 1 个且明细正确', r23.versionChanges.length === 1 && r23.versionChanges[0].id === 'B1' && r23.versionChanges[0].from === 'V1.0' && r23.versionChanges[0].to === 'V3.0');
    check('系统版本已同步为最新导入值 V3.0', state.bugs['B1'].fields['发现发布'] === 'V3.0');
    const r23b = E.updateVersion(state, 'B3', 'V9.0', '2026-08-15T10:00:00', '测试员');
    check('手动改版本生效', r23b.ok && state.bugs['B3'].fields['发现发布'] === 'V9.0');
    check('版本变更写入历史（可追溯）', state.history.some(h => h.id === 'B3' && h.source === 'verchange' && h.from === 'V2.0' && h.to === 'V9.0'));
    // 25.5 v1.41.0：导入同步更新标题（描述/创建人仍保留系统值，变更进导入历史明细）
    const r41 = E.applyImport(state, [mk({'编号':'B1','标题':'登录失败-已修正','描述':'原始描述','创建人':'测试组','状态':'处理中','发现发布':'V3.0','严重程度':'严重','停留天数':'9','当前责任人':'张伟'})], '2026-08-17T09:00:00');
    check('v1.41.0 导入后标题更新为新值', state.bugs['B1'].fields['标题'] === '登录失败-已修正');
    check('v1.41.0 标题变更写入导入历史明细', state.history.some(h => h.id === 'B1' && h.source === 'import' && h.changes && h.changes.some(c => c.field === '标题' && c.from === '登录失败' && c.to === '登录失败-已修正')));
    check('v1.41.0 描述仍保留系统值（受保护）', state.bugs['B1'].fields['描述'] === '这是一段超长的描述内容，用于验证鼠标悬停时能否完整显示全部描述信息，超过一定长度后应该被省略号截断显示');
    // 25.3 列表行内修改版本（UI 交互）
    document.querySelector('.nav-item[data-view="list"]').click();
    document.querySelector('#btnClearFilters').click();
    const verCell = document.querySelector('#bugTbody [data-veredit]');
    check('发现发布列可点击（ver-cell 存在）', !!verCell);
    verCell.click();
    const verSel = document.querySelector('#bugTbody .ver-select');
    check('点击后出现行内下拉', !!verSel);
    const curVal = verSel.value;
    const targetOpt = Array.from(verSel.options).find(o => o.value !== curVal && o.value !== '__custom__');
    if (targetOpt) { verSel.value = targetOpt.value; verSel.dispatchEvent(new Event('change')); }
    const newVerVal = targetOpt ? targetOpt.value : null;
    if (newVerVal) {
      check('行内修改版本后列表更新', Array.from(document.querySelectorAll('#bugTbody [data-veredit]')).some(el => el.textContent === newVerVal));
    }
    // 25.4 历史弹窗显示版本变更记录
    const hisB3 = document.querySelector('#bugTbody [data-act="history"][data-id="B3"]');
    if (hisB3) {
      hisB3.click();
      check('历史弹窗显示版本变更记录', document.querySelector('#historyBody').textContent.indexOf('版本变更') !== -1);
      document.querySelector('#historyModal .modal-close').click();
    }
    // 26. 导入字段变更明细历史（v1.27.0）
    const r26 = E.applyImport(state, [mk({'编号':'B4','标题':'新BUG-按钮无效','状态':'已解决','发现发布':'V2.0','严重程度':'轻微','停留天数':'3','当前责任人':'赵敏'})], '2026-08-16T09:00:00');
    const importRec = state.history.filter((h) => h.id === 'B4' && h.source === 'import' && h.changes).pop();
    check('导入变更明细记录（状态/停留天数）', !!importRec && importRec.changes.some((c) => c.field === '状态' && c.to === '已解决') && importRec.changes.some((c) => c.field === '停留天数' && c.to === '3'));
    // 历史弹窗显示导入变更明细（用 app.js state 中的 B3 导入更新记录验证渲染链路）
    document.querySelector('.nav-item[data-view="list"]').click();
    document.querySelector('#btnClearFilters').click();
    const hisB3b = document.querySelector('#bugTbody [data-act="history"][data-id="B3"]');
    if (hisB3b) {
      hisB3b.click();
      check('历史弹窗显示导入变更明细（字段+日期）', document.querySelector('#historyBody').textContent.indexOf('导入更新') !== -1 && document.querySelector('#historyBody').textContent.indexOf('状态') !== -1);
      document.querySelector('#historyModal .modal-close').click();
    }
    // 27. xlsx 按需加载（v1.27.0）：首屏不再静态加载 950KB SheetJS，仅导入/导出时动态加载
    check('xlsx 按需加载函数可用', typeof BugParser.ensureXlsx === 'function');
    check('页面不再静态引用 xlsx 库（首屏瘦身）', !document.querySelector('script[src*="xlsx"]'));
    // 28. 状态列手动「关闭」（v1.32.0）
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    const activeBefore = parseInt(document.querySelectorAll('#statCards .card .value')[2].textContent.trim(), 10);
    const solvedBefore = parseInt(document.querySelectorAll('#statCards .card .value')[1].textContent.trim(), 10);
    // 28.1 列表状态列可点击（行内下拉）
    document.querySelector('.nav-item[data-view="list"]').click();
    document.querySelector('#btnClearFilters').click();
    const stCell = document.querySelector('#bugTbody [data-statusedit]');
    check('状态列单元格可点击修改', !!stCell);
    if (stCell) {
      stCell.click();
      const stSel = document.querySelector('#bugTbody select.ver-select');
      check('点击状态出现行内下拉', !!stSel);
      if (stSel) {
        check('下拉含「关闭」枚举', Array.from(stSel.options).some((o) => o.value === '关闭'));
        stSel.value = '关闭';
        stSel.dispatchEvent(new Event('change'));
        check('修改状态弹出二次确认', !document.querySelector('#confirmModal').classList.contains('hidden'));
        document.querySelector('#btnConfirmOk').click();
      }
    }
    // 28.2 关闭后：列表仍可见（带「关闭」标签），看板未解决总数 -1，今日解决 +1
    const closedRow = Array.from(document.querySelectorAll('#bugTbody tr')).find((tr) => tr.textContent.indexOf('关闭') !== -1);
    check('关闭后 BUG 仍在列表且显示「关闭」', !!closedRow);
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    const activeAfter = parseInt(document.querySelectorAll('#statCards .card .value')[2].textContent.trim(), 10);
    check('关闭后看板未解决总数 -1', activeAfter === activeBefore - 1);
    const solvedAfter = parseInt(document.querySelectorAll('#statCards .card .value')[1].textContent.trim(), 10);
    check('关闭后今日解决 +1', solvedAfter === solvedBefore + 1);
    // 28.3 变更历史显示「状态变更」
    document.querySelector('.nav-item[data-view="list"]').click();
    const closedId = closedRow ? closedRow.dataset.id : null;
    if (closedId) {
      const hisBtn = document.querySelector('#bugTbody [data-act="history"][data-id="' + closedId + '"]');
      if (hisBtn) {
        hisBtn.click();
        check('历史弹窗显示状态变更记录', document.querySelector('#historyBody').textContent.indexOf('状态变更') !== -1 && document.querySelector('#historyBody').textContent.indexOf('关闭') !== -1);
        document.querySelector('#historyModal .modal-close').click();
      }
      // 28.4 手动改回其他状态 → 恢复活跃（看板未解决总数恢复）
      const stCell2 = document.querySelector('#bugTbody [data-statusedit="' + closedId + '"]');
      if (stCell2) {
        stCell2.click();

        const stSel2 = document.querySelector('#bugTbody select.ver-select');
        if (stSel2) {
          const reopenOpt = Array.from(stSel2.options).find((o) => o.value !== '关闭');
          if (reopenOpt) {
            stSel2.value = reopenOpt.value;
            stSel2.dispatchEvent(new Event('change'));
            document.querySelector('#btnConfirmOk').click();
          }
        }
      }
      document.querySelector('.nav-item[data-view="dashboard"]').click();
      const activeRestored = parseInt(document.querySelectorAll('#statCards .card .value')[2].textContent.trim(), 10);

      check('改回状态后恢复活跃（未解决总数恢复）', activeRestored === activeBefore);
      const solvedRestored = parseInt(document.querySelectorAll('#statCards .card .value')[1].textContent.trim(), 10);
      check('改回状态后今日解决回落', solvedRestored === solvedBefore);
    }
    // 29. 双击编号不弹详情 + 状态修改二次确认（v1.32.2）
    document.querySelector('.nav-item[data-view="list"]').click();
    document.querySelector('#btnClearFilters').click();
    const idCell = document.querySelector('#bugTbody .col-id');
    if (idCell) {
      idCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      check('双击编号列不弹出详情', document.querySelector('#detailModal').classList.contains('hidden'));
    }
    const titleCell = document.querySelector('#bugTbody .col-title');
    if (titleCell) {
      titleCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      check('双击其他列仍弹出详情', !document.querySelector('#detailModal').classList.contains('hidden'));
      document.querySelector('#detailModal .modal-close').click();
    }
    const stCell3 = document.querySelector('#bugTbody [data-statusedit]');
    const origStatus = stCell3 ? stCell3.textContent : '';
    if (stCell3) {
      stCell3.click();
      const stSel3 = document.querySelector('#bugTbody select.ver-select');
      if (stSel3) {
        const otherOpt = Array.from(stSel3.options).find((o) => o.value !== stSel3.value);
        if (otherOpt) { stSel3.value = otherOpt.value; stSel3.dispatchEvent(new Event('change')); }
      }
      check('取消场景：确认弹窗弹出', !document.querySelector('#confirmModal').classList.contains('hidden'));
      document.querySelector('#btnConfirmCancel').click();
    }
    const stCell3b = document.querySelector('#bugTbody [data-statusedit]');
    check('取消确认后状态不变', !!stCell3b && stCell3b.textContent === origStatus);
    // 30. 详情弹窗：标题含版本 + 点击编号复制 + 按钮区不随滚动（v1.32.4）
    const row30 = document.querySelector('#bugTbody tr');
    const rowVer = row30 ? row30.querySelector('[data-veredit]').textContent : '';
    if (row30) {
      row30.querySelector('.col-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      check('详情标题含发现发布版本', document.querySelector('#dtModalVer').textContent === rowVer);
      const dtIdEl = document.querySelector('#dtModalId');
      check('详情标题含编号', !!dtIdEl && dtIdEl.textContent.length > 0);
      const idText = dtIdEl.textContent;
      let copiedDetailId = '';
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: (t) => { copiedDetailId = t; return Promise.resolve(); } },
          configurable: true
        });
      } catch (e) {
        navigator.clipboard = { writeText: (t) => { copiedDetailId = t; return Promise.resolve(); } };
      }
      dtIdEl.click();
      check('点击编号自动复制单号', copiedDetailId === idText);
      // 按钮区在滚动容器之外（.detail-actions 是 .modal 直接子级，不在 .modal-body 内）
      const actionsParent = document.querySelector('#detailModal .detail-actions').parentElement;
      check('底部按钮固定在弹窗底部（不在滚动区）', actionsParent.classList.contains('modal') && !actionsParent.classList.contains('modal-body'));
      document.querySelector('#detailModal .modal-close').click();
    }
    // 31. 标签页标题不含版本号 + 责任人维度与列表一致（v1.32.6）
    check('标签页标题不含版本号', document.title === 'BUG 处理进展跟踪');
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    const ownerRow31 = document.querySelector('#ownerStats .person-row');
    if (ownerRow31) {
      const nums31 = ownerRow31.querySelector('.nums').textContent;
      const cardCnt31 = parseInt((nums31.match(/未解决 ([0-9]+)/) || [])[1] || '0', 10);
      const name31 = decodeURIComponent(ownerRow31.dataset.owner);
      ownerRow31.click();
      const listCnt31 = document.querySelectorAll('#bugTbody tr').length;
      check('责任人维度数量与列表一致（无筛选）', listCnt31 === cardCnt31);
      document.querySelector('#btnClearFilters').click();
    }
    // 开启版本筛选 V1.0 → 点张伟 → 列表联动版本筛选，行数与卡片一致
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    const verItem31 = Array.from(document.querySelectorAll('#verStats .stat-item')).find((i) => i.dataset.col === 'V1.0');
    if (verItem31) {
      verItem31.click();
      const zhang31 = Array.from(document.querySelectorAll('#ownerStats .person-row')).find((r) => r.dataset.owner === encodeURIComponent('张伟'));
      if (zhang31) {
        const nums31b = zhang31.querySelector('.nums').textContent;
        const cardCnt31b = parseInt((nums31b.match(/未解决 ([0-9]+)/) || [])[1] || '0', 10);
        zhang31.click();
        check('责任人点击联动看板版本筛选（已筛选 2 列）', document.querySelector('#filterInfo').textContent.indexOf('已筛选 2 列') !== -1);
        check('版本筛选后列表行数与卡片一致', document.querySelectorAll('#bugTbody tr').length === cardCnt31b);
      }
      document.querySelector('#btnShowAllVers').click();
    }
    document.querySelector('#btnClearFilters').click();
    // 32. 问题统计弹窗（v1.33.0）
    document.querySelector('.nav-item[data-view="dashboard"]').click();
    check('问题统计按钮存在', !!document.querySelector('#btnStatsModal'));
    document.querySelector('#btnStatsModal').click();
    check('问题统计弹窗打开', !document.querySelector('#statsModal').classList.contains('hidden'));
    const statsText1 = document.querySelector('#statsText').textContent;
    check('统计内容含截止时间', /截止[0-9]+月[0-9]+日[0-9]{2}:[0-9]{2}/.test(statsText1));
    check('统计内容含当前总计', statsText1.indexOf('当前总计') !== -1);
    check('统计内容含一般/严重/提示', statsText1.indexOf('一般问题') !== -1 && statsText1.indexOf('严重问题') !== -1 && statsText1.indexOf('提示问题') !== -1);
    // 一键复制
    let copiedStats = '';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (t) => { copiedStats = t; return Promise.resolve(); } },
        configurable: true
      });
    } catch (e) {
      navigator.clipboard = { writeText: (t) => { copiedStats = t; return Promise.resolve(); } };
    }
    document.querySelector('#btnStatsCopy').click();
    check('一键复制统计内容', copiedStats === statsText1);
    document.querySelector('#statsModal .modal-close').click();
    // 版本筛选联动：选 V1.0 → 弹窗内容仅含 V1.0 版本行
    const verItem32 = Array.from(document.querySelectorAll('#verStats .stat-item')).find((i) => i.dataset.col === 'V1.0');
    if (verItem32) {
      verItem32.click();
      document.querySelector('#btnStatsModal').click();
      const statsText2 = document.querySelector('#statsText').textContent;
      const v1line = statsText2.split('\\n').find((l) => l.indexOf('当前总计') !== -1);
      check('版本筛选后统计仅含所选版本', v1line.indexOf('v1.0') !== -1 || v1line.indexOf('V1.0') !== -1);
      document.querySelector('#statsModal .modal-close').click();
      document.querySelector('#btnShowAllVers').click();
    }
  } catch (e) {
    results.push('EXCEPTION | ' + e.message);
  }
  document.title = results.filter(r => r.startsWith('FAIL') || r.startsWith('EXCEPTION')).length === 0 ? 'SMOKE-ALL-PASS' : 'SMOKE-FAIL';
  document.body.insertAdjacentHTML('beforeend', '<div id="smokeResults" style="position:fixed;bottom:0;left:0;background:#111;color:#0f0;padding:10px;font:12px monospace;z-index:9999;white-space:pre">' + results.join('\\n') + '</div>');
}, 800);
</script>
<script>
// 截图验证辅助：URL hash 指定初始视图（#list / #view-list / #people / #import / #loginrecords）。
// DOMContentLoaded 同步切换（在 app.js init 之后立即执行，无需等待定时器）——
// headless Chrome 截图发生在 load 后，同步切换可被截图捕获。
document.addEventListener('DOMContentLoaded', () => {
  let hashView = (location.hash.replace('#', '')).replace(/^view-/, '');
  let todayNew = false;
  if (hashView.indexOf('-todaynew') !== -1) { todayNew = true; hashView = hashView.replace('-todaynew', ''); }
  const el = hashView && document.querySelector('.nav-item[data-view="' + hashView + '"]');
  if (el) {
    el.click();
    if (todayNew) { const b = document.querySelector('#btnTodayNew'); if (b) b.click(); }
  }
});
</script>`;

const out = indexHtml
  .replace(/src="vendor\//g, 'src="../vendor/')
  .replace(/src="js\//g, 'src="../js/')
  .replace(/href="css\//g, 'href="../css/')
  .replace('<script src="../js/app.js"></script>', '')
  .replace('</body>', testScript + '\n</body>');
fs.writeFileSync(path.join(__dirname, 'ui.smoke.html'), out);
console.log('ui.smoke.html 生成完毕');
