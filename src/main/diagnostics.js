'use strict';

/**
 * 页面诊断：当自动填写失败时，把当前页面里所有可能相关的输入框/按钮结构导出成 JSON，
 * 便于（由人或 AI）快速修正平台配置里的选择器。
 */

const fs = require('node:fs');
const path = require('node:path');

function pageScan() {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const deepAll = (root, sel, out) => {
    out = out || [];
    try {
      const list = root.querySelectorAll(sel);
      for (let i = 0; i < list.length; i += 1) out.push(list[i]);
    } catch (e) {
      /* ignore */
    }
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (let j = 0; j < nodes.length; j += 1) {
      if (nodes[j].shadowRoot) deepAll(nodes[j].shadowRoot, sel, out);
    }
    return out;
  };
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      const id = node.getAttribute('id');
      if (id && /^[A-Za-z][\w-]{0,50}$/.test(id)) {
        parts.unshift(`${part}#${id}`);
        break;
      }
      const attrs = ['name', 'type', 'placeholder', 'aria-label', 'data-testid'];
      let used = false;
      for (let i = 0; i < attrs.length; i += 1) {
        const attr = attrs[i];
        const v = node.getAttribute(attr);
        if (v && v.length <= 40 && !/["\n\r]/.test(v)) {
          part += `[${attr}="${v}"]`;
          used = true;
          break;
        }
      }
      if (!used) {
        const parent = node.parentElement;
        if (parent) {
          const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };
  const fields = [];
  const nodes = deepAll(document, 'input, textarea, select, [contenteditable="true"], [contenteditable=""]', []);
  for (let i = 0; i < nodes.length && fields.length < 80; i += 1) {
    const el = nodes[i];
    fields.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      css: cssPath(el),
      inShadow: !!(el.getRootNode && el.getRootNode().host),
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      accept: el.getAttribute('accept') || '',
      name: el.getAttribute('name') || '',
      value: el.value != null ? String(el.value).slice(0, 60) : '',
      text: norm(el.innerText || el.textContent).slice(0, 60),
      visible: isVisible(el),
      disabled: !!el.disabled,
      files: el.files ? el.files.length : 0,
    });
  }
  const buttons = [];
  const clickables = deepAll(document, 'button, a, [role="button"], [role="menuitem"], input[type="submit"], [class*="btn"], [class*="button"]', []);
  for (let i = 0; i < clickables.length && buttons.length < 80; i += 1) {
    const el = clickables[i];
    const text = norm(el.innerText || el.textContent || el.value);
    if (!text || text.length > 40) continue;
    buttons.push({
      tag: el.tagName.toLowerCase(),
      text,
      css: cssPath(el),
      inShadow: !!(el.getRootNode && el.getRootNode().host),
      visible: isVisible(el),
      disabled: !!el.disabled,
    });
  }
  const iframes = Array.prototype.map.call(document.querySelectorAll('iframe'), (f) => f.getAttribute('src') || '(empty)').slice(0, 20);
  let shadowHosts = 0;
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i += 1) if (all[i].shadowRoot) shadowHosts += 1;
  const shadowText = [];
  for (let i = 0; i < all.length && shadowText.length < 50; i += 1) {
    if (all[i].shadowRoot) shadowText.push(all[i].shadowRoot.textContent || '');
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodySnippet: norm((document.body ? document.body.innerText : '') + '\n' + shadowText.join('\n')).slice(0, 1500),
    fields,
    buttons,
    iframes,
    shadowHosts,
    fileInputCount: deepAll(document, 'input[type="file"]', []).length,
    scannedAt: new Date().toISOString(),
  };
}

const SCAN_SCRIPT = `(${pageScan.toString()})()`;

async function collect(view, meta = {}) {
  const base = { platformId: meta.platformId || '', platformName: meta.platformName || '', step: meta.step || '', error: meta.error || '' };
  try {
    const data = await view.webContents.executeJavaScript(SCAN_SCRIPT, true);
    return { ...base, ok: true, page: data };
  } catch (err) {
    return { ...base, ok: false, error: `${base.error} | 扫描失败：${err.message}` };
  }
}

function save(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 只保留最近 N 个文件，避免诊断/日志无限增长 */
function prune(dir, keep, ext) {
  try {
    const suffix = ext || '.json';
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of entries.slice(Math.max(0, keep))) {
      try {
        fs.unlinkSync(item.file);
      } catch (err) {
        /* ignore */
      }
    }
  } catch (err) {
    /* ignore */
  }
}

module.exports = { collect, save, prune, SCAN_SCRIPT, pageScan };
