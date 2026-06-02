// ===== Marked Config =====
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function(code, lang) {
    if (typeof hljs === 'undefined') return code;
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
    }
    try { return hljs.highlightAuto(code).value; } catch (e) {}
    return code;
  }
});

// ===== Mermaid Config =====
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    markdownAutoWrap: true,
    securityLevel: 'loose',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif',
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
    sequence: { useMaxWidth: true, diagramMargin: 10 },
    gantt: { useMaxWidth: true, tickInterval: 'day' },
    pie: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    mindmap: { useMaxWidth: true },
    er: { useMaxWidth: true, layoutDirection: 'TB' },
    gitGraph: { useMaxWidth: true, showCommitLabel: true },
    state: { useMaxWidth: true },
    class: { useMaxWidth: true },
  });
} else {
  console.warn('Mermaid library not loaded, chart rendering disabled');
}

// ===== State =====
const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const previewScroll = document.getElementById('previewScroll');
const tocSidebar = document.getElementById('tocSidebar');
const tocContent = document.getElementById('tocContent');
const tocToggleBtn = document.getElementById('tocToggleBtn');
const filenameEl = document.getElementById('filename');
const charCountEl = document.getElementById('charCount');
const lineCountEl = document.getElementById('lineCount');
const paraCountEl = document.getElementById('paraCount');
let renderTimer = null;
let currentFilename = '';
let tocVisible = false;
let scrollSyncEnabled = true;
let scrollSyncTimer = null;
let scrollSyncLock = false;
let scrollSyncRAF = null;
let previewDarkTheme = false;
let mermaidCounter = 0;

// ===== LocalStorage Auto-Save =====
const STORAGE_KEY_MD = 'mdviewer_content';
const STORAGE_KEY_FN = 'mdviewer_filename';

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY_MD, editor.value);
    if (currentFilename) localStorage.setItem(STORAGE_KEY_FN, currentFilename);
  } catch (e) { /* quota exceeded, ignore */ }
}

function loadFromStorage() {
  try {
    const content = localStorage.getItem(STORAGE_KEY_MD);
    const fn = localStorage.getItem(STORAGE_KEY_FN);
    if (content) {
      editor.value = content;
      if (fn) {
        currentFilename = fn;
        filenameEl.textContent = fn;
      }
      return true;
    }
  } catch (e) {}
  return false;
}

// Auto-save on every input (debounced)
let autoSaveTimer = null;
editor.addEventListener('input', () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 250);
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveToStorage, 1000);
});

// ===== Bidirectional Scroll Sync =====
function syncScroll(source, target) {
  if (scrollSyncLock) return;
  if (scrollSyncRAF) cancelAnimationFrame(scrollSyncRAF);

  scrollSyncRAF = requestAnimationFrame(() => {
    const sourceEl = source === 'editor' ? editor : previewScroll;
    const targetEl = source === 'editor' ? previewScroll : editor;

    const sourceScrollHeight = sourceEl.scrollHeight - sourceEl.clientHeight;
    const targetScrollHeight = targetEl.scrollHeight - targetEl.clientHeight;

    if (sourceScrollHeight <= 0 || targetScrollHeight <= 0) return;

    const ratio = sourceEl.scrollTop / sourceScrollHeight;
    scrollSyncLock = true;
    targetEl.scrollTop = ratio * targetScrollHeight;

    setTimeout(() => { scrollSyncLock = false; }, 50);
    scrollSyncRAF = null;
  });
}

// Attach scroll listeners
editor.addEventListener('scroll', () => {
  if (!scrollSyncEnabled) return;
  syncScroll('editor', 'preview');
});

previewScroll.addEventListener('scroll', () => {
  if (!scrollSyncEnabled) return;
  syncScroll('preview', 'editor');
});

// ===== Detect Chart Type =====
function detectChartType(content) {
  const c = content.trim().toLowerCase();
  if (c.startsWith('flowchart') || c.startsWith('graph ') || /^(TD|TB|BT|LR|RL)\b/.test(c)) return '🔀 流程图';
  if (c.startsWith('sequencediagram')) return '📡 时序图';
  if (c.startsWith('classdiagram')) return '🏗️ 类图';
  if (c.startsWith('statediagram')) return '🔄 状态图';
  if (c.startsWith('gantt')) return '📅 甘特图';
  if (c.startsWith('pie')) return '🥧 饼图';
  if (c.startsWith('mindmap')) return '🧠 思维导图';
  if (c.startsWith('erdiagram')) return '🗄️ 实体关系图';
  if (c.startsWith('journey')) return '🗺️ 用户旅程图';
  if (c.startsWith('gitgraph')) return '🌿 Git 分支图';
  if (c.startsWith('architecture')) return '🌐 网络拓扑图';
  return '📊 图表';
}

// ===== Escape HTML =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Generate Stable Heading ID =====
function generateStableId(text) {
  return 'h-' + text.toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);
}

// ===== Build TOC =====
function buildTOC() {
  const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
  if (headings.length === 0) {
    tocContent.innerHTML = '<div class="toc-empty">暂无标题<br><br>在 Markdown 中使用 # 标题<br>即可生成目录</div>';
    return;
  }

  const root = { level: 0, children: [] };
  const stack = [root];

  headings.forEach((h) => {
    const level = parseInt(h.tagName.charAt(1), 10);
    const text = h.textContent.trim();
    const id = h.id || generateStableId(text);
    h.id = id;

    const node = { level, text, id, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });

  tocContent.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'toc-list';
  renderTOCNodes(root.children, ul);
  tocContent.appendChild(ul);

  updateScrollSpyHeadings();
}

function renderTOCNodes(nodes, parent) {
  nodes.forEach((node) => {
    const li = document.createElement('li');
    li.className = 'toc-item';

    const link = document.createElement('a');
    link.className = 'toc-link';
    link.href = '#' + node.id;
    link.setAttribute('data-target', node.id);

    const icons = ['', '🔶', '🔷', '▪️', '▪️', '▪️', '▪️'];
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toc-icon';
    iconSpan.textContent = icons[node.level] || '▪️';
    link.appendChild(iconSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'toc-text';
    textSpan.textContent = node.text;
    link.appendChild(textSpan);

    if (node.children.length > 0) {
      const toggle = document.createElement('span');
      toggle.className = 'toc-toggle';
      toggle.textContent = '▼';
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const childUl = li.querySelector(':scope > .toc-children');
        if (childUl) {
          const isCollapsed = childUl.classList.toggle('collapsed');
          toggle.classList.toggle('collapsed', isCollapsed);
        }
      });
      link.appendChild(toggle);
    }

    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(node.id);
      if (target) {
        scrollSyncEnabled = false;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => { scrollSyncEnabled = true; }, 600);
      }
    });

    li.appendChild(link);

    if (node.children.length > 0) {
      const childUl = document.createElement('ul');
      childUl.className = 'toc-children';
      renderTOCNodes(node.children, childUl);
      li.appendChild(childUl);
    }

    parent.appendChild(li);
  });
}

// ===== Scroll Spy (single persistent listener) =====
let scrollSpyHeadings = [];

function updateScrollSpyHeadings() {
  scrollSpyHeadings = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6'));
}

// Attach scroll spy listener ONCE at init time
(function initScrollSpy() {
  let scrollSpyTimer = null;
  previewScroll.addEventListener('scroll', () => {
    if (!scrollSyncEnabled) return;
    clearTimeout(scrollSpyTimer);
    scrollSpyTimer = setTimeout(() => {
      const scrollTop = previewScroll.scrollTop;
      let activeId = '';
      for (let i = scrollSpyHeadings.length - 1; i >= 0; i--) {
        const el = scrollSpyHeadings[i];
        if (el && el.offsetTop - 40 <= scrollTop) {
          activeId = el.id;
          break;
        }
      }
      const tocLinks = tocContent.querySelectorAll('.toc-link');
      tocLinks.forEach((link) => {
        const target = link.getAttribute('data-target');
        link.classList.toggle('active', target === activeId);
      });
      if (activeId) {
        const activeLink = tocContent.querySelector(`.toc-link[data-target="${activeId}"]`);
        if (activeLink) activeLink.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);
  });
})();

// ===== Toggle TOC =====
function toggleTOC() {
  // Rebuild TOC from current preview every time sidebar opens (defense in depth)
  buildTOC();
  tocVisible = !tocVisible;
  tocSidebar.classList.toggle('hidden', !tocVisible);
  tocToggleBtn.classList.toggle('active', tocVisible);
}

// ===== Toggle Scroll Sync =====
function toggleScrollSync() {
  scrollSyncEnabled = !scrollSyncEnabled;
  const btn = document.getElementById('syncToggleBtn');
  btn.classList.toggle('active', scrollSyncEnabled);
  btn.textContent = scrollSyncEnabled ? '🔄 同步滚动' : '🔄 独立滚动';
  showToast(scrollSyncEnabled ? '✅ 同步滚动已开启' : '✅ 同步滚动已关闭');
}

// ===== Toggle Preview Theme =====
function togglePreviewTheme() {
  previewDarkTheme = !previewDarkTheme;
  previewScroll.classList.toggle('dark-theme', previewDarkTheme);
  const btn = document.getElementById('themeToggleBtn');
  btn.textContent = previewDarkTheme ? '☀️ 预览主题' : '🌙 预览主题';
  btn.classList.toggle('active', previewDarkTheme);
  showToast(previewDarkTheme ? '🌙 暗色预览主题' : '☀️ 亮色预览主题');

  // Update mermaid theme
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false,
      theme: previewDarkTheme ? 'dark' : 'default',
      markdownAutoWrap: true,
      securityLevel: 'loose',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
      sequence: { useMaxWidth: true, diagramMargin: 10 },
      gantt: { useMaxWidth: true, tickInterval: 'day' },
      pie: { useMaxWidth: true },
      journey: { useMaxWidth: true },
      mindmap: { useMaxWidth: true },
      er: { useMaxWidth: true, layoutDirection: 'TB' },
      gitGraph: { useMaxWidth: true, showCommitLabel: true },
      state: { useMaxWidth: true },
      class: { useMaxWidth: true },
    });
  }
  render();
}

// ===== Render =====
function render() {
  const md = editor.value;
  const lines = md.split('\n');
  const paragraphs = md.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  charCountEl.textContent = md.length.toLocaleString();
  lineCountEl.textContent = lines.length.toLocaleString();
  paraCountEl.textContent = paragraphs.length.toLocaleString();

  // Extract mermaid blocks
  const mermaidBlocks = [];
  let processedMd = md.replace(/```mermaid\s*\n([\s\S]*?)```/g, (match, content) => {
    const id = `MERMAID_BLOCK_${mermaidBlocks.length}`;
    mermaidBlocks.push({ content: content.trim(), id });
    return `%%${id}%%`;
  });

  // Extract LaTeX blocks
  const latexBlocks = [];
  processedMd = processedMd.replace(/\$\$([\s\S]*?)\$\$/g, (match, content) => {
    const id = `LATEX_DISPLAY_${latexBlocks.length}`;
    latexBlocks.push({ content: content.trim(), id, display: true });
    return `%%${id}%%`;
  });
  processedMd = processedMd.replace(/(?<!`)\$([^\$\n]+?)\$(?!`)/g, (match, content) => {
    const id = `LATEX_INLINE_${latexBlocks.length}`;
    latexBlocks.push({ content: content.trim(), id, display: false });
    return `%%${id}%%`;
  });

  // Render markdown
  let html = marked.parse(processedMd);

  // Replace mermaid placeholders
  mermaidBlocks.forEach((block) => {
    const chartType = detectChartType(block.content);
    const encoded = btoa(unescape(encodeURIComponent(block.content)));
    const wrapper = `
      <div class="mermaid-container" data-idx="${mermaidCounter++}">
        <div class="mermaid-label"><span class="dot"></span>${chartType}</div>
        <div class="mermaid-svg-wrap"><div class="mermaid-chart" data-source="${encoded}"></div></div>
        <div class="mermaid-actions">
          <button onclick="downloadSVG(this)">⬇ SVG</button>
          <button onclick="downloadPNG(this)">⬇ PNG</button>
        </div>
      </div>`;
    html = html.replace(`%%${block.id}%%`, wrapper);
  });

  // Replace LaTeX placeholders
  latexBlocks.forEach((block) => {
    const placeholder = `%%${block.id}%%`;
    if (html.includes(placeholder)) {
      if (block.display) {
        try {
          const rendered = katex.renderToString(block.content, { displayMode: true, throwOnError: false });
          html = html.replace(placeholder, rendered);
        } catch (e) {
          html = html.replace(placeholder, `<div class="katex-error">⚠️ LaTeX 公式渲染失败: ${escapeHtml(e.message)}</div>`);
        }
      } else {
        try {
          const rendered = katex.renderToString(block.content, { displayMode: false, throwOnError: false });
          html = html.replace(placeholder, rendered);
        } catch (e) {
          html = html.replace(placeholder, `<span class="katex-error">⚠️ ${escapeHtml(block.content)}</span>`);
        }
      }
    }
  });

  preview.innerHTML = html;

  // Build TOC immediately after preview update (before any exception-prone code)
  buildTOC();

  // Add copy buttons to code blocks
  preview.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = '📋 复制';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✅ 已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '📋 复制';
          btn.classList.remove('copied');
        }, 2000);
      });
    });
    pre.appendChild(btn);
  });

  // Re-highlight code blocks (hljs inside marked) — guard against CDN load failure
  if (typeof hljs !== 'undefined') {
    preview.querySelectorAll('pre code').forEach((block) => {
      if (!block.classList.contains('hljs')) {
        try { hljs.highlightElement(block); } catch (e) { /* ignore hljs errors */ }
      }
    });
  }

  // Render mermaid charts (parallel)
  renderMermaidCharts();

  // Auto-save
  saveToStorage();
}

// ===== Render Mermaid Charts (Parallel) =====
async function renderMermaidCharts() {
  const charts = document.querySelectorAll('.mermaid-chart');
  const tasks = Array.from(charts).map(async (chart) => {
    const source = decodeURIComponent(escape(atob(chart.getAttribute('data-source'))));
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    try {
      const { svg } = await mermaid.render(id, source);
      chart.innerHTML = svg;
    } catch (err) {
      const container = chart.closest('.mermaid-container');
      // 清除 mermaid.render() 失败时自动创建在 DOM 中的错误 SVG（mermaid v10 创建 <div id="d{id}"> 并追加到 body）
      const errSvgParent = document.getElementById('d' + id);
      if (errSvgParent) errSvgParent.remove();
      const lineMatch = err.message.match(/on line (\d+)/);
      const lineNo = lineMatch ? lineMatch[1] : '';
      container.innerHTML = `
        <div class="mermaid-error">
          <div class="err-title">⚠️ 流程图语法不兼容</div>
          <div class="err-msg">${escapeHtml(err.message || '图表渲染失败，请检查语法')}</div>
          <details>
            <summary>查看原始代码${lineNo ? '（错误在第 ' + lineNo + ' 行附近）' : ''}</summary>
            <pre>${escapeHtml(source)}</pre>
          </details>
          <div class="hint">该流程图使用了 Mermaid v10 不兼容的语法（如 >=, (), &lt;&gt;, 特殊符号等），查看器已忽略此块，不影响其他图表和功能。</div>
        </div>`;
    }
  });
  await Promise.allSettled(tasks);
  try { mermaid.contentLoaded(); } catch (e) {}
}

// ===== File Operations =====
function openFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,.mdx,.txt';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    loadFile(file);
  };
  input.click();
}

function saveFile() {
  const content = editor.value;
  const name = currentFilename || 'document.md';
  downloadFile(content, name, 'text/markdown');
  showToast('✅ 文件已保存');
}

function exportHTML() {
  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(currentFilename || 'Markdown')}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-light.min.css">
<style>body{max-width:900px;margin:40px auto;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
pre{background:#f6f8fa;padding:16px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:8px 14px}thead{background:#f6f8fa}</style>
</head><body class="markdown-body">${preview.innerHTML}</body></html>`;
  const name = (currentFilename || 'document').replace(/\.\w+$/, '') + '.html';
  downloadFile(htmlContent, name, 'text/html');
  showToast('✅ HTML 已导出');
}

function exportPDF() {
  window.print();
  showToast('🖨️ 请使用打印对话框保存为 PDF');
}

function copyMD() {
  navigator.clipboard.writeText(editor.value).then(() => showToast('✅ Markdown 原文已复制到剪贴板'));
}

function copyRendered() {
  // Clone the preview DOM and clean up internal UI elements
  const clone = preview.cloneNode(true);

  // Remove code block copy buttons
  clone.querySelectorAll('.code-copy-btn').forEach(el => el.remove());

  // Remove mermaid action buttons (⬇ SVG, ⬇ PNG)
  clone.querySelectorAll('.mermaid-actions').forEach(el => el.remove());

  // Remove mermaid chart type labels (🔀 流程图, etc.)
  clone.querySelectorAll('.mermaid-label').forEach(el => el.remove());

  // Remove search highlights
  clone.querySelectorAll('.search-highlight').forEach(span => {
    span.replaceWith(document.createTextNode(span.textContent));
  });
  clone.normalize();

  // Remove welcome screen if visible
  clone.querySelectorAll('.welcome').forEach(el => el.remove());

  // Remove KaTeX errors
  clone.querySelectorAll('.katex-error').forEach(el => el.remove());

  // Create a temporary contenteditable container for native copy
  const temp = document.createElement('div');
  temp.contentEditable = 'true';
  temp.style.position = 'fixed';
  temp.style.left = '-9999px';
  temp.style.top = '-9999px';
  temp.style.opacity = '0';
  temp.style.overflow = 'auto';
  temp.style.width = '800px';
  temp.style.maxHeight = '80vh';
  temp.style.background = '#fff';
  temp.style.color = '#1e1e2e';
  temp.style.padding = '20px';
  temp.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif";
  temp.style.fontSize = '15px';
  temp.style.lineHeight = '1.75';

  // Move cloned content into temp container
  while (clone.firstChild) {
    temp.appendChild(clone.firstChild);
  }
  document.body.appendChild(temp);

  // Copy table styling inline (for better paste compatibility)
  temp.querySelectorAll('table').forEach(table => {
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';
    table.style.margin = '16px 0';
    table.querySelectorAll('th, td').forEach(cell => {
      cell.style.border = '1px solid #d0d7de';
      cell.style.padding = '8px 14px';
    });
    table.querySelectorAll('thead').forEach(thead => {
      thead.style.background = '#f6f8fa';
    });
  });

  // Style code blocks for paste
  temp.querySelectorAll('pre').forEach(pre => {
    pre.style.background = '#f6f8fa';
    pre.style.padding = '16px';
    pre.style.borderRadius = '8px';
    pre.style.overflow = 'auto';
    pre.style.margin = '16px 0';
    pre.querySelectorAll('code').forEach(code => {
      code.style.background = 'none';
      code.style.padding = '0';
    });
  });

  // Style inline code
  temp.querySelectorAll('p code, li code, td code, blockquote code').forEach(code => {
    code.style.background = '#f0f0f0';
    code.style.padding = '2px 6px';
    code.style.borderRadius = '4px';
    code.style.fontFamily = "'JetBrains Mono', 'Fira Code', monospace";
    code.style.fontSize = '0.9em';
    code.style.color = '#cf222e';
  });

  // Select all content and copy
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(temp);
  selection.removeAllRanges();
  selection.addRange(range);

  try {
    // execCommand('copy') preserves rich HTML in clipboard
    const success = document.execCommand('copy');
    if (success) {
      showToast('🎨 渲染内容已复制（支持富文本粘贴到 Word/飞书等）');
    } else {
      throw new Error('execCommand copy failed');
    }
  } catch (e) {
    // Last resort: plain text fallback
    navigator.clipboard.writeText(clone.innerText || clone.textContent)
      .then(() => showToast('🎨 渲染文本已复制（纯文本）'))
      .catch(() => showToast('❌ 复制失败，请手动选择预览内容复制'));
  } finally {
    selection.removeAllRanges();
    document.body.removeChild(temp);
  }
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ===== Chart Export =====
function downloadSVG(btn) {
  const container = btn.closest('.mermaid-container');
  const svg = container.querySelector('svg');
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  downloadFile(svgData, 'chart.svg', 'image/svg+xml');
  showToast('✅ SVG 已下载');
}

function downloadPNG(btn) {
  const container = btn.closest('.mermaid-container');
  const svg = container.querySelector('svg');
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'chart.png';
      a.click();
      URL.revokeObjectURL(url);
      showToast('✅ PNG 已下载');
    }, 'image/png');
  };
  img.src = url;
}

// ===== File Validation =====
const SUPPORTED_EXTS = /\.(md|markdown|mdx|txt)$/i;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Validate file before loading. Checks:
 * 1. File exists
 * 2. File extension is supported
 * 3. File size is under limit
 * 4. File is text (not binary)
 * @returns {string|null} Error message, or null if valid
 */
function validateFile(file) {
  if (!file) return '未检测到文件';
  if (!SUPPORTED_EXTS.test(file.name)) {
    return `不支持的文件格式: .${file.name.split('.').pop()}\n仅支持 .md / .markdown / .mdx / .txt`;
  }
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return `文件过大: ${sizeMB}MB，超过限制 ${MAX_FILE_SIZE / (1024 * 1024)}MB`;
  }
  return null;
}

/**
 * Check if file content is binary by scanning for null bytes.
 * @param {ArrayBuffer} buffer
 * @returns {boolean} true if binary
 */
function isBinaryContent(buffer) {
  const bytes = new Uint8Array(buffer);
  const sampleSize = Math.min(bytes.length, 8192); // Check first 8KB
  for (let i = 0; i < sampleSize; i++) {
    if (bytes[i] === 0) return true; // Null byte = binary
  }
  return false;
}

// ===== Load File =====
function loadFile(file) {
  const error = validateFile(file);
  if (error) {
    showToast('❌ ' + error);
    return;
  }

  // 清除延迟渲染定时器，防止旧内容覆盖新文件
  clearTimeout(renderTimer);
  clearTimeout(autoSaveTimer);

  const reader = new FileReader();
  reader.onerror = () => {
    showToast('❌ 文件读取失败，请重试');
  };
  reader.onload = (ev) => {
    // Check for binary content
    if (ev.target.result instanceof ArrayBuffer) {
      if (isBinaryContent(ev.target.result)) {
        showToast('❌ 检测到二进制文件，仅支持纯文本 Markdown 文件');
        return;
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(ev.target.result);
      // Check for too many null/replacement characters
      if (text.includes('\uFFFD') && text.split('\uFFFD').length > text.length * 0.01) {
        showToast('❌ 文件编码异常，可能不是有效的文本文件');
        return;
      }
      editor.value = text;
    } else {
      editor.value = ev.target.result;
    }
    currentFilename = file.name;
    filenameEl.textContent = file.name;
    render();
    showToast('✅ 文件已打开');
  };

  // Read as ArrayBuffer first to detect binary content
  reader.readAsArrayBuffer(file);
}

// ===== Drag & Drop =====
const dragOverlay = document.getElementById('dragOverlay');
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dragOverlay.classList.add('active');
});
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragOverlay.classList.remove('active');
    dragCounter = 0;
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove('active');
  const file = e.dataTransfer.files[0];
  if (file) {
    loadFile(file);
  }
});

// ===== Resizer =====
const resizer = document.getElementById('resizer');
const editorPane = document.querySelector('.editor-pane');
let isResizing = false;

resizer.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizer.classList.add('active');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const main = document.querySelector('.main');
  const rect = main.getBoundingClientRect();
  const percent = ((e.clientX - rect.left) / rect.width) * 100;
  const clamped = Math.max(20, Math.min(80, percent));
  editorPane.style.width = clamped + '%';
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
    e.preventDefault();
    openFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 't') {
    e.preventDefault();
    toggleTOC();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
    e.preventDefault();
    toggleScrollSync();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    toggleSearch();
  }
  if (e.key === 'Escape') {
    if (searchActive) toggleSearch();
  }
});

// ===== Search =====
let searchActive = false;
let searchHighlights = [];
let searchCurrentIdx = -1;

function toggleSearch() {
  searchActive = !searchActive;
  const searchBar = document.getElementById('searchBar');
  const main = document.querySelector('.main');
  if (searchActive) {
    searchBar.classList.add('active');
    main.style.marginTop = '88px'; // 44px toolbar + 44px search bar
    document.getElementById('searchInput').focus();
  } else {
    searchBar.classList.remove('active');
    main.style.marginTop = '44px';
    clearSearchHighlights();
    document.getElementById('searchInput').value = '';
    document.getElementById('searchInfo').textContent = '';
  }
}

function performSearch() {
  clearSearchHighlights();
  const query = document.getElementById('searchInput').value;
  if (!query || query.length < 2) {
    document.getElementById('searchInfo').textContent = '';
    return;
  }

  const previewEl = document.getElementById('preview');
  const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  while (walker.nextNode()) {
    // Skip text nodes inside code elements to avoid breaking code
    if (walker.currentNode.parentElement.tagName === 'CODE' ||
        walker.currentNode.parentElement.closest('.mermaid-container')) continue;
    textNodes.push(walker.currentNode);
  }

  let count = 0;
  searchCurrentIdx = -1;

  textNodes.forEach((node) => {
    const text = node.textContent;
    const regex = new RegExp(escapeRegex(query), 'gi');
    if (!regex.test(text)) return;
    regex.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const span = document.createElement('span');
      span.className = 'search-highlight';
      span.textContent = match[0];
      span.dataset.searchIdx = count;
      fragment.appendChild(span);
      searchHighlights.push(span);
      count++;
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    node.parentNode.replaceChild(fragment, node);
  });

  const infoEl = document.getElementById('searchInfo');
  if (count === 0) {
    infoEl.textContent = '未找到';
  } else {
    searchCurrentIdx = 0;
    searchHighlights[0].classList.add('current');
    searchHighlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    infoEl.textContent = `1 / ${count}`;
  }
}

function navigateSearch(direction) {
  if (searchHighlights.length === 0) return;
  searchHighlights[searchCurrentIdx].classList.remove('current');
  searchCurrentIdx += direction;
  if (searchCurrentIdx < 0) searchCurrentIdx = searchHighlights.length - 1;
  if (searchCurrentIdx >= searchHighlights.length) searchCurrentIdx = 0;
  searchHighlights[searchCurrentIdx].classList.add('current');
  searchHighlights[searchCurrentIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('searchInfo').textContent = `${searchCurrentIdx + 1} / ${searchHighlights.length}`;
}

function clearSearchHighlights() {
  searchHighlights.forEach((span) => {
    const parent = span.parentNode;
    parent.replaceChild(document.createTextNode(span.textContent), span);
    parent.normalize();
  });
  searchHighlights = [];
  searchCurrentIdx = -1;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ===== Toast =====
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ===== Default Demo Content =====
const demo = `__DEMO_CONTENT_PLACEHOLDER__`;

// ===== Init =====
(function init() {
  const hasStorage = loadFromStorage();
  if (!hasStorage) {
    editor.value = demo;
  }
  render();
})();