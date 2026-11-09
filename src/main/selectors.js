'use strict';

/**
 * 页面内的元素定位脚本集合。
 * 所有函数都会被序列化后注入页面执行，因此不能引用模块作用域里的任何变量。
 * 约定：命中元素会打上 data-dsh-hit="1"，文件输入打上 data-dsh-file="1"，方便 CDP 再次定位。
 */

const PAGE_HELPERS = `(function () {
  window.__dshAll = function (root, sel, out) {
    out = out || [];
    root = root || document;
    try {
      var list = root.querySelectorAll(sel);
      for (var i = 0; i < list.length; i++) out.push(list[i]);
    } catch (e) {}
    var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.shadowRoot) window.__dshAll(el.shadowRoot, sel, out);
    }
    return out;
  };
  window.__dshDeep = function (sel) {
    var arr = window.__dshAll(document, sel, []);
    return arr.length ? arr[0] : null;
  };
  window.__dshText = function () {
    var parts = [];
    if (document.body) parts.push(document.body.innerText || document.body.textContent || '');
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) parts.push(all[i].shadowRoot.textContent || '');
    }
    return parts.join('\\n');
  };
  window.__dshMarked = function () {
    var el = window.__dshEl;
    if (el && el.isConnected) return el;
    return window.__dshDeep('[data-dsh-hit="1"]') || window.__dshDeep('[data-dsh-file="1"]');
  };
})();`;

function toScript(fn, ...args) {
  return `${PAGE_HELPERS}(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

/* ------------------------------------------------------------------ */
/* 页面内：通用元素查找                                                 */
/* ------------------------------------------------------------------ */
function pageFind(candidates, opts) {
  opts = opts || {};
  const res = {
    found: false,
    candidate: null,
    tag: null,
    rect: null,
    text: '',
    value: null,
    placeholder: '',
    disabled: false,
    visible: false,
    count: 0,
  };
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  };
  const clickableScore = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    if (tag === 'button' || tag === 'a' || role === 'button' || role === 'menuitem') return -1000000;
    if (el.hasAttribute('onclick')) return -500000;
    return 0;
  };
  const textMatch = (needle, exact) => {
    if (!needle) return null;
    const scope = window.__dshAll(
      document,
      'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], label, span, div, li, p, input[type="button"], input[type="submit"]',
      []
    );
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < scope.length; i++) {
      const el = scope[i];
      const raw = el.tagName.toLowerCase() === 'input' ? el.value : el.innerText || el.textContent;
      const t = norm(raw);
      if (!t || t.length > 80) continue;
      const hit = exact ? t === needle : t.indexOf(needle) >= 0;
      if (!hit) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const score = r.width * r.height + clickableScore(el);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  };
  const describe = (el, cand) => {
    const r = el.getBoundingClientRect();
    res.found = true;
    res.candidate = cand;
    res.tag = el.tagName.toLowerCase();
    res.rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    res.text = norm(el.innerText || el.textContent).slice(0, 120);
    res.value = el.value != null ? String(el.value) : null;
    res.placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
    res.disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
    res.visible = isVisible(el);
  };
  try {
    window.__dshAll(document, '[data-dsh-hit], [data-dsh-file]', []).forEach((el) => {
      el.removeAttribute('data-dsh-hit');
      el.removeAttribute('data-dsh-file');
      el.removeAttribute('data-dsh-file-tag');
    });
  } catch (e) {
    /* ignore */
  }
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const matches = [];
  for (let i = 0; i < list.length; i++) {
    const cand = list[i];
    if (!cand || typeof cand !== 'string') continue;
    let el = null;
    try {
      if (cand.indexOf('text==') === 0) {
        el = textMatch(cand.slice(6), true);
      } else if (cand.indexOf('text=') === 0) {
        el = textMatch(cand.slice(5), false);
      } else {
        el = window.__dshDeep(cand);
      }
    } catch (e) {
      el = null;
    }
    if (el && el.isConnected) matches.push({ el, cand });
  }
  if (!matches.length) return res;
  res.count = matches.length;
  const visibles = matches.filter((m) => isVisible(m.el));
  const chosen = visibles.length ? visibles[0] : matches[0];
  window.__dshEl = chosen.el;
  chosen.el.setAttribute('data-dsh-hit', '1');
  describe(chosen.el, chosen.cand);
  return res;
}

/* ------------------------------------------------------------------ */
/* 页面内：文件输入定位                                                 */
/* ------------------------------------------------------------------ */
function pageMarkFileInput(selectors, acceptHint) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase();
  const inputs = window.__dshAll(document, 'input[type="file"]', []);
  const list = [];
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    const accept = norm(el.getAttribute('accept'));
    let score = 0;
    if (acceptHint && accept.indexOf(norm(acceptHint)) >= 0) score += 100;
    if (accept.indexOf('video') >= 0) score += 30;
    if (accept.indexOf('image') >= 0) score -= 10;
    const r = el.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) score += 5;
    const styles = window.getComputedStyle(el);
    if (styles.display !== 'none') score += 2;
    list.push({ el, score, accept, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  }
  if (selectors && selectors.length) {
    for (let i = 0; i < selectors.length; i++) {
      let el = null;
      try {
        el = window.__dshDeep(selectors[i]);
      } catch (e) {
        el = null;
      }
      if (el && el.tagName && el.tagName.toLowerCase() === 'input' && el.type === 'file') {
        const found = list.find((x) => x.el === el);
        if (found) found.score += 1000;
      }
    }
  }
  if (!list.length) {
    return { found: false, count: 0, total: 0, accept: '', rect: null, inShadow: 0 };
  }
  list.sort((a, b) => b.score - a.score);
  const best = list[0];
  window.__dshAll(document, '[data-dsh-file]', []).forEach((el) => el.removeAttribute('data-dsh-file'));
  window.__dshEl = best.el;
  best.el.setAttribute('data-dsh-file', '1');
  best.el.setAttribute('data-dsh-file-tag', 'video');
  return {
    found: true,
    count: list.length,
    total: inputs.length,
    accept: best.accept,
    rect: best.rect,
  };
}

/* ------------------------------------------------------------------ */
/* 页面内：命中元素操作                                                 */
/* ------------------------------------------------------------------ */
function pageHitInfo() {
  const el = window.__dshMarked();
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  return {
    found: true,
    tag,
    type: el.getAttribute('type') || '',
    accept: el.getAttribute('accept') || '',
    placeholder: el.getAttribute('placeholder') || '',
    value: el.value != null ? String(el.value) : null,
    text: String(el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80),
    editable: !!(el.isContentEditable || el.getAttribute('contenteditable') === 'true'),
    disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
  };
}

function pageFocusHit() {
  const el = window.__dshMarked();
  if (!el) return { ok: false, reason: 'not_found' };
  try {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
    if (el.focus) el.focus();
  } catch (e) {
    /* ignore */
  }
  const editable = !!(el.isContentEditable || el.getAttribute('contenteditable') === 'true');
  return { ok: document.activeElement === el || editable, editable };
}

function pageSetInputValue(text, clearFirst) {
  const el = window.__dshMarked();
  if (!el) return { ok: false, reason: 'not_found' };
  const tag = el.tagName.toLowerCase();
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    return { ok: false, reason: 'contenteditable' };
  }
  if (tag !== 'input' && tag !== 'textarea') return { ok: false, reason: 'unsupported_tag' };
  try {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (clearFirst !== false) {
      el.select && el.select();
      desc.set.call(el, '');
    }
    desc.set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    return { ok: true, value: el.value, tag };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function pageSelectHitContents() {
  const el = window.__dshMarked();
  if (!el) return { ok: false };
  try {
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (el.select) el.select();
      return { ok: true };
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function pageHitText() {
  const el = window.__dshMarked();
  if (!el) return { found: false, text: '' };
  return { found: true, text: String(el.innerText || el.textContent || '').trim().slice(0, 500) };
}

function pageClickHit() {
  const el = window.__dshMarked();
  if (!el) return { ok: false, reason: 'not_found' };
  try {
    el.click();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function pageScrollHitIntoView() {
  const el = window.__dshMarked();
  if (!el) return { ok: false, reason: 'not_found' };
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch (e) {
    try {
      el.scrollIntoView();
    } catch (e2) {
      /* ignore */
    }
  }
  const r = el.getBoundingClientRect();
  return { ok: true, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
}

function pageCaretToEnd() {
  const el = window.__dshMarked();
  if (!el) return { ok: false, reason: 'not_found' };
  try {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function pageExecInsertText(text) {
  const el = window.__dshMarked();
  if (!el) return { ok: false, reason: 'not_found' };
  try {
    el.focus();
    return { ok: document.execCommand('insertText', false, text) };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

/* ------------------------------------------------------------------ */
/* 页面内：上传状态与登录判断                                           */
/* ------------------------------------------------------------------ */
function pageUploadState(pendingTexts, doneSelectors, titleSelectors) {
  const pending = [];
  const body = window.__dshText();
  for (let i = 0; i < pendingTexts.length; i++) {
    const t = pendingTexts[i];
    if (t && body.indexOf(t) >= 0) pending.push(t);
  }
  let done = null;
  for (let i = 0; i < doneSelectors.length; i++) {
    try {
      if (window.__dshDeep(doneSelectors[i])) {
        done = doneSelectors[i];
        break;
      }
    } catch (e) {
      /* ignore */
    }
  }
  const fileInputs = window.__dshAll(document, 'input[type="file"]', []);
  const hasFile = fileInputs.some((el) => el.files && el.files.length > 0);
  const fileNames = [];
  fileInputs.forEach((el) => {
    if (el.files) for (let i = 0; i < el.files.length; i++) fileNames.push(el.files[i].name);
  });
  let videoReady = false;
  const videos = window.__dshAll(document, 'video', []);
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
    if (src && (v.readyState >= 1 || v.duration > 0 || v.videoWidth > 0)) {
      videoReady = true;
      break;
    }
  }
  const percentMatch = body.match(/(\d{1,3})\s*%/);
  const progress = percentMatch ? percentMatch[1] : '';
  let editorReady = false;
  const titleOptions = titleSelectors || [];
  for (let i = 0; i < titleOptions.length; i++) {
    try {
      const el = window.__dshDeep(titleOptions[i]);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 2 && r.height > 2) {
          editorReady = true;
          break;
        }
      }
    } catch (e) {
      /* ignore */
    }
  }
  return {
    pending,
    done,
    hasFile,
    fileNames,
    videoReady,
    videoCount: videos.length,
    progress,
    editorReady,
    url: location.href,
    bodyLength: body.length,
    title: document.title,
  };
}

function pageTriggerFileChange() {
  const el = window.__dshMarked() || window.__dshDeep('input[type="file"]');
  if (!el) return { ok: false, reason: 'not_found' };
  try {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, files: el.files ? el.files.length : 0 };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function pageClearFileInput() {
  const el = window.__dshMarked() || window.__dshDeep('input[type="file"]');
  if (!el) return { ok: false, reason: 'not_found' };
  try {
    el.value = '';
    return { ok: true, files: el.files ? el.files.length : 0 };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function pageHasTexts(texts) {
  const body = window.__dshText();
  const hits = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (t && body.indexOf(t) >= 0) hits.push(t);
  }
  return { hits, url: location.href };
}

function pageLoginState(selectors, urlExcludes, rejectTexts) {  const body = window.__dshText();
  const hits = [];
  for (let i = 0; i < selectors.length; i++) {
    try {
      if (window.__dshDeep(selectors[i])) hits.push(selectors[i]);
    } catch (e) {
      /* ignore */
    }
  }
  const rejectHits = [];
  const rejects = rejectTexts || [];
  for (let i = 0; i < rejects.length; i++) {
    const t = rejects[i];
    if (t && body.indexOf(t) >= 0) rejectHits.push(t);
  }
  const hasFileInput = window.__dshAll(document, 'input[type="file"]', []).length > 0;
  const url = location.href;
  const excluded = !!(urlExcludes && url.indexOf(urlExcludes) >= 0);
  const loggedIn = hits.length > 0 && !excluded && rejectHits.length === 0;
  return {
    url,
    hits,
    rejectHits,
    hasFileInput,
    excluded,
    loggedIn,
    hasLoginText: /扫码登录|账号登录|手机号登录|登录后|Sign in/i.test(body),
  };
}

/* ------------------------------------------------------------------ */
/* 页面内：取当前频道的 channelId（YouTube 专用）                       */
/* ------------------------------------------------------------------ */
function pageChannelId() {
  const m = String(location.pathname || '').match(/\/channel\/(UC[\w-]+)/);
  if (m) return m[1];
  const links = Array.from(document.querySelectorAll('a[href*="/channel/UC"]'));
  for (const a of links) {
    const hit = String(a.getAttribute('href') || '').match(/\/channel\/(UC[\w-]+)/);
    if (hit) return hit[1];
  }
  return '';
}

function pageVisibleTextExists(texts) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const list = texts || [];
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const candidates = window.__dshAll(document, 'button, a, [role="button"], label, span, div', []);
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i];
    const text = norm(el.innerText || el.textContent);
    if (!text || text.length > 30) continue;
    if (list.indexOf(text) >= 0 && isVisible(el)) return { found: true, text };
  }
  return { found: false };
}

/* ------------------------------------------------------------------ */
/* 页面内：按可见文本点击按钮（用于弹窗里的 保存/完成/确定）             */
/* ------------------------------------------------------------------ */
function pageClickByText(texts) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const list = texts || [];
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const candidates = window.__dshAll(document, 'button, a, [role="button"], label, span, div', []);
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates[i];
    const text = norm(el.innerText || el.textContent);
    if (!text || text.length > 30) continue;
    if (list.indexOf(text) < 0) continue;
    if (!isVisible(el)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const r = el.getBoundingClientRect();
    const score = r.width * r.height;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return { found: false };
  const rect = best.getBoundingClientRect();
  return {
    found: true,
    text: norm(best.innerText || best.textContent),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  };
}

/* ------------------------------------------------------------------ */
/* 主进程：登录态判定（IPC 与引擎共用同一套规则）                        */
/* ------------------------------------------------------------------ */
function judgeLogin(state, cfg) {
  if (!state || state.excluded) return false;
  const check = cfg || {};
  if (check.urlIncludes && String(state.url || '').indexOf(check.urlIncludes) < 0) return false;
  return !!(state.loggedIn || (state.hasFileInput && !(state.rejectHits || []).length));
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */
module.exports = {
  toScript,
  judgeLogin,
  findScript: (candidates, opts) => toScript(pageFind, candidates || [], opts || {}),
  fileInputScript: (selectors, acceptHint) => toScript(pageMarkFileInput, selectors || [], acceptHint || 'video'),
  channelIdScript: () => toScript(pageChannelId),
  triggerFileChangeScript: () => toScript(pageTriggerFileChange),
  clearFileInputScript: () => toScript(pageClearFileInput),
  hitInfoScript: () => toScript(pageHitInfo),
  focusHitScript: () => toScript(pageFocusHit),
  setInputValueScript: (text, clearFirst) => toScript(pageSetInputValue, text, clearFirst !== false),
  selectHitContentsScript: () => toScript(pageSelectHitContents),
  hitTextScript: () => toScript(pageHitText),
  clickHitScript: () => toScript(pageClickHit),
  uploadStateScript: (pendingTexts, doneSelectors, titleSelectors) =>
    toScript(pageUploadState, pendingTexts || [], doneSelectors || [], titleSelectors || []),
  loginStateScript: (selectors, urlExcludes, rejectTexts) =>
    toScript(pageLoginState, selectors || [], urlExcludes || '', rejectTexts || []),
  textScript: (texts) => toScript(pageHasTexts, texts || []),
  scrollHitIntoViewScript: () => toScript(pageScrollHitIntoView),
  caretToEndScript: () => toScript(pageCaretToEnd),
  execInsertTextScript: (text) => toScript(pageExecInsertText, text),
  clickByTextScript: (texts) => toScript(pageClickByText, texts || []),
  visibleTextScript: (texts) => toScript(pageVisibleTextExists, texts || []),
  pageFind,
};
