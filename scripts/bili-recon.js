'use strict';

/**
 * B 站投稿页侦察：用 CDP 驱动本机 Chrome（独立 profile，复用已登录 Cookie），
 * 打开创作者中心投稿页，导出页面结构 + 截图，供后续填写步骤确认选择器。
 *
 * 只读：不点击投稿、不改页面内容。
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const WebSocket = require('ws');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.BILI_PORT || 9333);
const PROFILE = process.env.BILI_PROFILE || path.join(os.tmpdir(), 'bili-prof');
const TARGET_URL = process.env.BILI_URL || 'https://member.bilibili.com/platform/upload/video/frame';
const OUT_DIR = path.join(__dirname, '..', '.artifacts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, timeoutMs = 1500) {
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
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl, { maxPayload: 256 * 1024 * 1024 });
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
      }
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
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
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
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

async function ensureChrome() {
  try {
    const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    if (v && v.webSocketDebuggerUrl) return { reused: true, wsUrl: v.webSocketDebuggerUrl };
  } catch (e) {
    /* not running */
  }
  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  if (!fs.existsSync(path.join(PROFILE, 'Default', 'Network', 'Cookies'))) {
    throw new Error(`profile 里没有 Cookies：${PROFILE}`);
  }
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--window-size=1440,1000',
    'about:blank',
  ];
  spawn(CHROME, args, { stdio: 'ignore', detached: false, windowsHide: false });
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      const v = await getJson(`http://127.0.0.1:${PORT}/json/version`);
      if (v && v.webSocketDebuggerUrl) return { reused: false, wsUrl: v.webSocketDebuggerUrl };
    } catch (e) {
      /* retry */
    }
  }
  throw new Error('Chrome 调试端口未就绪');
}

const RECON = `(function(){
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
    files.push({accept:el.getAttribute('accept')||'',name:el.getAttribute('name')||'',visible:vis(el),cls:(el.className||'').toString().slice(0,60)});
  });
  var fields=[];
  document.querySelectorAll('input,textarea,[contenteditable=true]').forEach(function(el,i){
    if(fields.length>=25||!vis(el)) return;
    fields.push({tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',
      ph:el.getAttribute('placeholder')||'',cls:(el.className||'').toString().slice(0,60),
      val:String(el.value||'').slice(0,40)});
  });
  var buttons=[];
  document.querySelectorAll('button,a,[role=button],div[class*=btn],span[class*=btn]').forEach(function(el){
    var t=norm(el.innerText||el.textContent);
    if(!t||t.length>16||buttons.length>=40||!vis(el)) return;
    buttons.push(t);
  });
  return {
    url: location.href,
    title: document.title,
    bodyLen: (document.body?document.body.innerText.length:0),
    bodyHead: norm(document.body?document.body.innerText:'').slice(0,600),
    loginHint: /扫码登录|密码登录|短信登录|登录后/.test(document.body?document.body.innerText:''),
    userHints: document.querySelectorAll('[class*=avatar],[class*=user-info],[class*=userInfo]').length,
    fileInputs: files,
    fields: fields,
    buttons: buttons
  };
})()`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { reused, wsUrl } = await ensureChrome();
  const cdp = new Cdp(wsUrl);
  await cdp.connect();

  const { targetId } = await cdp.send('Target.createTarget', { url: TARGET_URL });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  // 等首屏渲染完（SPA）
  await sleep(9000);

  const evalSafe = async (expr) => {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (res && res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'eval failed');
    }
    return res && res.result ? res.result.value : undefined;
  };

  const state = await evalSafe(RECON);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(OUT_DIR, 'bili-recon.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

  // 另存一份「当前是不是登录页」的判定，方便肉眼/后续核对
  const report = { reused, profile: PROFILE, targetUrl: TARGET_URL, screenshot: file, state };
  const jsonFile = path.join(OUT_DIR, 'bili-recon.json');
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));

  cdp.close();
  // 保留 Chrome 进程，后续步骤继续用同一个 profile/session
  console.log(`CHROME_KEPT_OPEN=1 PORT=${PORT}`);
}

main().catch((err) => {
  console.error('RECON_FAILED:', err && err.message ? err.message : String(err));
  process.exit(1);
});
