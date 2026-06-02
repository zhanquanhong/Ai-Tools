#!/usr/bin/env python3
"""Generate index.html for MD Viewer v2.0.0.
Takes the original HTML, combines with extracted JS + demo content.
Keeps onclick handlers intact (they work fine with the complete JS).
"""
import os, sys

def main():
    bak_path = os.path.join(os.path.dirname(__file__), 'index.html.bak')
    with open(bak_path, 'r', encoding='utf-8') as f:
        orig = f.read()

    # 1. Extract demo content
    start = orig.find("const demo = `")
    end = orig.find("`;\n\n// ===== Init =====", start)
    demo_content = orig[start + len("const demo = `"):end]

    # 2. Extract CSS
    css_start = orig.find('<style>')
    css_end = orig.find('</style>', css_start)
    css = orig[css_start:css_end + 8]

    # 3. Inject additional CSS
    insert = css.rfind('}')
    extra_css = '''
    .toast.error { color: var(--error); border-color: var(--error); }
    .cdn-error-banner { display: none; position: fixed; top: 0; left: 0; right: 0; z-index: 9999; padding: 12px 20px; background: #fff5f5; border-bottom: 2px solid #e53e3e; color: #c53030; font-size: 14px; text-align: center; font-weight: 600; }
    .cdn-error-banner.show { display: block; }
    .loading-indicator { display: none; position: fixed; top: 44px; left: 0; right: 0; z-index: 998; padding: 6px 16px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 12px; text-align: center; }
    .loading-indicator.show { display: block; }
    @media (max-width: 767px) {
      .main { flex-direction: column; }
      .editor-pane { width: 100% !important; height: 45%; }
      .resizer { width: 100%; height: 4px; cursor: row-resize; }
      .preview-area { flex: 1; min-height: 0; }
      .preview-scroll { padding: 16px 20px; }
      .toc-sidebar { position: fixed; top: 44px; right: 0; bottom: 0; z-index: 500; width: 280px; box-shadow: -4px 0 12px rgba(0,0,0,0.2); }
      .toc-sidebar.hidden { width: 0; }
      .toolbar-brand { font-size: 13px; margin-right: 6px; }
      .toolbar-btn { padding: 4px 8px; font-size: 11px; }
      .toolbar-info .stat-item { display: none; }
      .toolbar-info .stat-item:first-child { display: flex; }
      .search-bar { flex-wrap: wrap; }
      .search-input { min-width: 80px; }
    }
'''
    css = css[:insert] + extra_css + css[insert:]

    # 4. Inject CDN error banner + loading indicator after <body>
    body_idx = orig.find('<body>')
    head_end = orig.find('</head>')
    body_start_end = orig.find('>', body_idx) + 1  # end of <body> tag

    injected_html = (
        '\n<div class="cdn-error-banner" id="cdnErrorBanner" role="alert"></div>'
        '\n<div class="loading-indicator" id="loadingIndicator">\u23f3 \u6b63\u5728\u52a0\u8f7d\u8d44\u6e90\uff0c\u8bf7\u7a0d\u5019...</div>\n'
    )

    # 5. Read the extracted JS and replace demo placeholder
    script_path = os.path.join(os.path.dirname(__file__), 'script.js')
    if not os.path.exists(script_path):
        print(f"ERROR: {script_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(script_path, 'r', encoding='utf-8') as f:
        js_content = f.read()

    js_content = js_content.replace('__DEMO_CONTENT_PLACEHOLDER__', demo_content)

    # 6. Assemble final file: keep original head (replace CSS), keep original body with onclick, inject JS
    #    Head: from <head> to </style>, then extra CSS, then rest of head
    orig_head = orig[:head_end + len('</head>')]
    # Replace the old <style> block with the updated one
    head_before_style = orig_head[:css_start]
    head_after_style = orig_head[css_end + 8:]
    new_head = head_before_style + css + head_after_style

    # Body: everything after <body> up to <script>
    body_html_start = body_start_end
    body_html_end = orig.find('<script>')
    body_html = orig[body_html_start:body_html_end]

    # Remove the original init script (we inject new JS)
    orig_script_start = orig.find('<script>')
    orig_script_end = orig.find('</script>', orig_script_start) + len('</script>')
    after_script = orig[orig_script_end:]

    final = (
        new_head + '\n<body>\n' +
        injected_html +
        body_html.strip() + '\n' +
        '<script>\n' +
        js_content + '\n' +
        '</script>\n' +
        '</body>\n</html>\n'
    )

    out_path = os.path.join(os.path.dirname(__file__), 'index.html')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(final)

    verify(out_path)


def verify(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    issues = []
    if '</script>' not in content:
        issues.append("Missing </script>")
    if '</html>' not in content:
        issues.append("Missing </html>")
    if '<script>' not in content:
        issues.append("Missing <script>")
    # Check if onclick handlers are preserved (needed for buttons to work)
    onclick_count = content.count('onclick=')
    if onclick_count == 0:
        issues.append("No onclick handlers found (buttons will not work)")

    if issues:
        print(f"VERIFY FAILED: {'; '.join(issues)}", file=sys.stderr)
        sys.exit(1)
    else:
        print(f"VERIFY OK: {len(content)} bytes, {content.count(chr(10))} lines, {onclick_count} onclick handlers", file=sys.stderr)


if __name__ == '__main__':
    main()
