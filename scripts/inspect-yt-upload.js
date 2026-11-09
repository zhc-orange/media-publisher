'use strict';

/**
 * 诊断 YouTube 上传弹窗：打开 d=ud 上传页，注入文件后检查标题/简介字段所在层。
 * 用法：node scripts/inspect-yt-upload.js [http://127.0.0.1:PORT]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const base = process.argv[2] || 'http://127.0.0.1:61650';
const channelId = process.env.MP_YT_CHANNEL || '';
const channelUrl = channelId ? `https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud` : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    ws.once('open', () =>
      resolve({
        send(method, params, sessionId) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { resolve: res, reject: rej });
            const payload = { id: mid, method, params: params || {} };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
          });
        },
        close() {
          ws.close();
        },
      })
    );
    ws.once('error', reject);
  });
}

async function main() {
  if (!channelUrl) {
    console.error('请通过 MP_YT_CHANNEL 环境变量指定 YouTube 频道 ID（UC 开头）');
    app.exit(1);
    return;
  }
  const version = await getJson(`${base}/json/version`);
  const browser = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = { send: (m, p) => browser.send(m, p, sessionId) };
  const report = {};

  const fake = process.env.MP_VIDEO || path.join(os.tmpdir(), 'yt-probe-fake.mp4');
  if (!process.env.MP_VIDEO) fs.writeFileSync(fake, Buffer.alloc(1024 * 8, 7));

  const evaluate = async (expression) => {
    const res = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (res.exceptionDetails) return { error: res.exceptionDetails.text };
    return res.result ? res.result.value : null;
  };

  try {
    await page.send('Page.enable');
    await page.send('DOM.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: channelUrl });
    await sleep(9000);
    report.href = await evaluate('location.href');

    // 注入假文件（只为了看表单结构，随后会关掉这个临时标签）
    const { root } = await page.send('DOM.getDocument', { depth: 0, pierce: true });
    const found = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    report.fileNode = found && found.nodeId ? found.nodeId : 0;
    if (found && found.nodeId) await page.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [fake] });
    await sleep(9000);

    report.after = await evaluate(
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          return out;
        }
        var more = deepAll(document, '*', []).filter(function (el) {
          var txt = String(el.innerText || '').trim();
          var aria = String(el.getAttribute('aria-label') || '');
          return (txt.indexOf('显示更多') >= 0 || aria.indexOf('显示更多') >= 0) && el.getBoundingClientRect().width > 0;
        }).slice(0, 8).map(function (el) {
          return { tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 40), txt: String(el.innerText || '').trim().slice(0, 30), aria: String(el.getAttribute('aria-label') || '') };
        });
        var tagInputs = deepAll(document, '#tags-container input, input[aria-label*="标签"], input[name*="tag"]', []);
        return {
          moreCandidates: more,
          tagContainers: deepAll(document, '#tags-container', []).length,
          tagInputs: tagInputs.length,
          bodyTail: document.body.innerText.slice(-900)
        };
      })()`
    );
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
  } finally {
    console.log(JSON.stringify(report, null, 2));
    try {
      await browser.send('Target.closeTarget', { targetId });
    } catch (err) {
      /* ignore */
    }
    try {
      fs.unlinkSync(fake);
    } catch (err) {
      /* ignore */
    }
    browser.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
