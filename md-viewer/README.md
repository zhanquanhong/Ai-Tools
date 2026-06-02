# MD Viewer

功能完整的 Markdown 编辑器，支持实时预览、Mermaid 流程图、LaTeX 公式、代码高亮、目录导航。

## 文件说明

| 文件 | 用途 | 使用方式 |
|------|------|---------|
| `index.html` | 在线版，需联网加载 CDN 库 | 双击 `file://` 或 HTTP 服务器 |
| `index.standalone.html` | 离线版，所有 JS/CSS 已内嵌（3.9MB） | 双击 `file://` 直接使用 |
| `lib/fonts/` | KaTeX 字体（standalone 版依赖） | 与 standalone.html 保持同目录 |
| `script.js` | JS 源码（开发用） | - |
| `gen2.py` | 构建脚本（开发用） | `python3 gen2.py` |

## 功能

- Markdown 实时编辑预览
- Mermaid 流程图（flowchart / sequenceDiagram 等 15+ 类型）
- LaTeX 公式渲染（KaTeX）
- 代码语法高亮（highlight.js）
- 自动生成目录导航
- 文件拖放导入 / 打开文件
- 导出 HTML / PDF / SVG
- 双向滚动同步
- 暗色预览主题
- Ctrl+F 搜索
- 自动保存到 localStorage

## 使用

**在线版：** 双击 `index.html`，需联网。

**离线版：** 解压后双击 `index.standalone.html`，零网络、零配置。

## 修复历史

- v2.0: TOC 不更新修复（buildTOC 前移至 preview.innerHTML 之后 + toggleTOC 入口重建）
- v2.0: hljs / mermaid CDN 加载失败不崩页（typeof 守卫 + try-catch）
- v2.0: markdownAutoWrap 支持 `<br>` 换行语法
- v2.0: mermaid 语法错误不遮挡页面（自动清除 DOM 中错误 SVG）
- v2.0: 单文件离线版（所有 JS/CSS 内嵌，Chrome file:// 直开）
