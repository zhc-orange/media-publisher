'use strict';

/**
 * 通用 CDP 驱动小工具：连接已经在调试端口上运行的 Chrome，对当前页面执行动作。
 * 用途：B 站投稿流程的侦察与填写（本文件不点「投稿」，发布动作单独确认）。
 *
 * 用法（BILI_PORT 默认 9334）：
 *   node scripts/cdp-util.js cookies
 *   node scripts/cdp-util.js goto <url>
 *   node scripts/cdp-util.js eval "<js expression>"
 *   node scripts/cdp-util.js shot [name]
 *   node scripts/cdp-util.js upload <file> [cssSelector]
 *   node scripts/cdp-util.js fill "<target>" "<text>"
 *   node scripts/cdp-util.js click "<target>"
 *   node scripts/cdp-util.js info
 *
 * <target> 支持 CSS 选择器，或 text=包含的文字 / text==完全一致。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = Number(process.env.BILI_PORT || 9334);
const OUT = path.join(__dirname, '..', '.artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('bad json'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = [];
  }

  waitEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== onHit);
        reject(new Error(`等待事件超时：${method}`));
      }, timeoutMs);
      const onHit = (msg) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w.resolve !== onHit);
        resolve(msg);
      };
      this.waiters.push({ method, resolve: onHit, reject });
    });
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl, { maxPayload: 512 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws connect timeout')), 15000);
      this.ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (e) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const w of this.waiters.slice()) {
          if (w.method === msg.method) w.resolve(msg);
        }
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 90000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

async function connectPage() {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const pages = list.filter((t) => t.type === 'page');
  const target = pages.find((t) => /bilibili/i.test(t.url)) || pages[0];
  if (!target) throw new Error('没有可用的页面 target');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  return { cdp, target };
}

/* ---------- 页面内工具：深穿透查找 + 文本匹配 + 标记 ---------- */

const PAGE_HELPERS = `
window.__uAll = function(root, sel, out){
  out = out || []; root = root || document;
  try { var list = root.querySelectorAll(sel); for (var i=0;i<list.length;i++) out.push(list[i]); } catch(e){}
  var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
  for (var j=0;j<all.length;j++){ if (all[j].shadowRoot) window.__uAll(all[j].shadowRoot, sel, out); }
  return out;
};
window.__uDeep = function(sel){ var a = window.__uAll(document, sel, []); return a.length ? a[0] : null; };
window.__uFind = function(target){
  var t = String(target || '');
  if (t.indexOf('text==') === 0 || t.indexOf('text=') === 0) {
    var exact = t.indexOf('text==') === 0;
    var needle = t.slice(exact ? 6 : 5).trim();
    var scope = window.__uAll(document, 'button,a,[role=button],[role=menuitem],label,span,div,p,li', []);
    var best = null;
    for (var i=0;i<scope.length;i++){
      var el = scope[i];
      var txt = (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim();
      if (!txt || txt.length > 80) continue;
      var hit = exact ? txt === needle : txt.indexOf(needle) >= 0;
      if (!hit) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (!best || txt.length < best.txt.length) best = { el: el, txt: txt };
    }
    return best ? best.el : null;
  }
  return window.__uDeep(t);
};
window.__uMark = function(target){
  var el = window.__uFind(target);
  if (!el) return { ok:false, reason:'not_found' };
  try { el.scrollIntoView({ block:'center', inline:'center' }); } catch(e){}
  var r = el.getBoundingClientRect();
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.value || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,60),
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    editable: !!(el.isContentEditable || el.getAttribute('contenteditable') === 'true')
  };
};
window.__uSet = function(target, text){
  var el = window.__uFind(target);
  if (!el) return { ok:false, reason:'not_found' };
  el.focus();
  var tag = el.tagName.toLowerCase();
  var editable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  if (!editable && (tag === 'input' || tag === 'textarea')) {
    var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, mode: 'value', value: el.value };
  }
  return { ok: false, mode: 'needs-keyboard', tag: tag, editable: editable };
};
`;

async function evalJs(cdp, expr) {
  const res = await cdp.send('Runtime.evaluate', {
    expression: `(function(){ ${PAGE_HELPERS}; return (${expr}); })()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'eval failed');
  }
  return res && res.result ? res.result.value : undefined;
}

async function clickAt(cdp, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
}

async function typeText(cdp, text) {
  await cdp.send('Input.insertText', { text: String(text) });
}

async function pressKey(cdp, key) {
  const map = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
  const vk = map[key] || 0;
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code: key,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: key,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await sleep(120);
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (!cmd) throw new Error('缺少命令');
  fs.mkdirSync(OUT, { recursive: true });
  const { cdp, target } = await connectPage();

  try {
    if (cmd === 'info') {
      console.log(JSON.stringify({ port: PORT, url: target.url, title: target.title }, null, 2));
      return;
    }

    if (cmd === 'cookies') {
      await cdp.send('Network.enable');
      const { cookies } = await cdp.send('Network.getAllCookies');
      const bili = cookies.filter((c) => /bilibili/i.test(c.domain));
      console.log(
        JSON.stringify(
          {
            total: cookies.length,
            bilibiliCount: bili.length,
            names: bili.map((c) => ({
              name: c.name,
              domain: c.domain,
              expired: c.expires > 0 ? c.expires * 1000 < Date.now() : false,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    if (cmd === 'goto') {
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: a1 });
      await sleep(1500);
      const st = await evalJs(cdp, `({ url: location.href, ready: document.readyState })`);
      console.log(JSON.stringify(st, null, 2));
      return;
    }

    if (cmd === 'eval') {
      const out = await evalJs(cdp, a1);
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      return;
    }

    if (cmd === 'recon') {
      const out = await evalJs(
        cdp,
        `(function(){
          var norm = function(s){ return String(s==null?'':s).replace(/\\s+/g,' ').trim(); };
          var vis = function(el){
            if(!el||!el.isConnected) return false;
            var r=el.getBoundingClientRect();
            if(r.width<2||r.height<2) return false;
            var cs=getComputedStyle(el);
            return cs.visibility!=='hidden'&&cs.display!=='none';
          };
          var files=[];
          document.querySelectorAll('input[type=file]').forEach(function(el){
            files.push({accept:el.getAttribute('accept')||'',visible:vis(el),cls:String(el.className||'').slice(0,50)});
          });
          var fields=[];
          document.querySelectorAll('input,textarea,[contenteditable=true]').forEach(function(el){
            if(fields.length>=20||!vis(el)) return;
            fields.push({tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',
              ph:el.getAttribute('placeholder')||'',cls:String(el.className||'').slice(0,50),
              val:String(el.value||'').slice(0,30)});
          });
          var buttons=[];
          document.querySelectorAll('button,[role=button],div[class*=btn],span[class*=btn]').forEach(function(el){
            var t=norm(el.innerText||el.textContent);
            if(!t||t.length>14||buttons.length>=30||!vis(el)) return;
            if(buttons.indexOf(t)<0) buttons.push(t);
          });
          return {
            url: location.href,
            title: document.title,
            bodyHead: norm(document.body?document.body.innerText:'').slice(0,700),
            fileInputs: files,
            fields: fields,
            buttons: buttons
          };
        })()`
      );
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (cmd === 'shot') {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${a1 || 'shot'}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`SHOT=${file}`);
      return;
    }

    if (cmd === 'upload') {
      const file = a1;
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
      await cdp.send('DOM.enable');
      const picked = await cdp.send('Runtime.evaluate', {
        expression: `(function(){ ${PAGE_HELPERS};
          var inputs = window.__uAll(document, 'input[type=file]', []);
          var best = null, bestScore = -1;
          for (var i = 0; i < inputs.length; i++) {
            var el = inputs[i];
            var acc = String(el.getAttribute('accept') || '').toLowerCase();
            var score = 0;
            if (acc.indexOf('.mp4') >= 0 || acc.indexOf('video') >= 0) score += 10;
            if (acc.indexOf('.txt') >= 0) score -= 100;
            var r = el.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) score += 3;
            if (score > bestScore) { bestScore = score; best = el; }
          }
          return best;
        })()`,
        returnByValue: false,
      });
      const objectId = picked && picked.result && picked.result.objectId;
      if (!objectId) throw new Error('页面上没有视频文件输入框');
      await cdp.send('DOM.setFileInputFiles', { objectId, files: [path.resolve(file)] });
      // B 站的上传组件只认原生 change，手动补一次（幂等，不会再弹对话框）
      const dispatched = await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(){
          this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return this.files ? this.files.length : 0;
        }`,
        returnByValue: true,
      });
      console.log(JSON.stringify({ ok: true, file: path.resolve(file), files: dispatched.result && dispatched.result.value }, null, 2));
      return;
    }

    if (cmd === 'upload-click') {
      // 拦截原生文件选择框 → 可信点击「上传视频」→ 直接给该 input 塞文件
      const file = a1;
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
      await cdp.send('Page.enable');
      await cdp.send('DOM.enable');
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
      const waitChooser = cdp.waitEvent('Page.fileChooserOpened', 15000);
      const mark = await evalJs(cdp, `window.__uMark(${JSON.stringify(a2 || 'text=上传视频')})`);
      if (!mark || !mark.ok) throw new Error('找不到「上传视频」按钮');
      await clickAt(cdp, mark.rect.x + mark.rect.w / 2, mark.rect.y + mark.rect.h / 2);
      const ev = await waitChooser;
      const backendNodeId = ev.params && ev.params.backendNodeId;
      await cdp.send('DOM.setFileInputFiles', { backendNodeId, files: [path.resolve(file)] });
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      console.log(JSON.stringify({ ok: true, backendNodeId, file: path.resolve(file) }, null, 2));
      return;
    }

    if (cmd === 'fill') {
      const targetSel = a1;
      const text = a2 == null ? '' : a2;
      const set = await evalJs(cdp, `window.__uSet(${JSON.stringify(targetSel)}, ${JSON.stringify(text)})`);
      if (set && set.ok) {
        console.log(JSON.stringify(set, null, 2));
        return;
      }
      const mark = await evalJs(cdp, `window.__uMark(${JSON.stringify(targetSel)})`);
      if (!mark || !mark.ok) throw new Error('找不到目标元素');
      await clickAt(cdp, mark.rect.x + Math.min(mark.rect.w / 2, 12), mark.rect.y + mark.rect.h / 2);
      await sleep(120);
      // 全选后覆盖输入
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await sleep(80);
      await cdp.send('Input.insertText', { text: String(text) });
      await sleep(250);
      const check = await evalJs(cdp, `(function(){ var el = window.__uFind(${JSON.stringify(targetSel)}); if(!el) return 'gone'; return el.isContentEditable ? (el.innerText||'').slice(0,60) : String(el.value||'').slice(0,60); })()`);
      console.log(JSON.stringify({ ok: true, mode: 'keyboard', target: mark, readback: check }, null, 2));
      return;
    }

    if (cmd === 'run') {
      const modPath = path.resolve(a1);
      const mod = require(modPath);
      if (typeof mod !== 'function') throw new Error(`${modPath} 需要导出 async function`);
      const api = {
        cdp,
        target,
        evalJs: (expr) => evalJs(cdp, expr),
        clickAt: (x, y) => clickAt(cdp, x, y),
        pressKey: (key) => pressKey(cdp, key),
        typeText: (text) => typeText(cdp, text),
        sleep,
      };
      const out = await mod(api);
      console.log(JSON.stringify(out === undefined ? { ok: true } : out, null, 2));
      return;
    }

    if (cmd === 'key') {
      await pressKey(cdp, a1 || 'Escape');
      console.log(JSON.stringify({ ok: true, key: a1 || 'Escape' }, null, 2));
      return;
    }

    if (cmd === 'clickxy') {
      const x = Number(a1);
      const y = Number(a2);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要 x y 坐标');
      await clickAt(cdp, x, y);
      await sleep(400);
      console.log(JSON.stringify({ ok: true, x, y }, null, 2));
      return;
    }

    if (cmd === 'click') {
      const mark = await evalJs(cdp, `window.__uMark(${JSON.stringify(a1)})`);
      if (!mark || !mark.ok) throw new Error(`找不到目标：${a1}`);
      await clickAt(cdp, mark.rect.x + mark.rect.w / 2, mark.rect.y + mark.rect.h / 2);
      await sleep(400);
      console.log(JSON.stringify({ ok: true, clicked: mark }, null, 2));
      return;
    }

    throw new Error(`未知命令：${cmd}`);
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error('CDP_UTIL_FAILED:', err && err.message ? err.message : String(err));
  process.exit(1);
});
