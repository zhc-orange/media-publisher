'use strict';

/**
 * 诊断 YouTube Studio：在现有 Chrome 里开一个临时标签，检查上传弹窗/Shadow DOM 结构。
 * 用法：node scripts/inspect-yt.js [http://127.0.0.1:PORT]
 */

const WebSocket = require('ws');

const base = process.argv[2] || 'http://127.0.0.1:61650';
const channelUrl = 'https://studio.youtube.com/videos/upload?d=ud';

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
    const events = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else {
        events.push(msg);
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
        events,
      })
    );
    ws.once('error', reject);
  });
}

async function evaluate(page, expression) {
  const res = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) return { error: res.exceptionDetails.text };
  return res.result ? res.result.value : null;
}

async function main() {
  const version = await getJson(`${base}/json/version`);
  const browser = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    send: (m, p) => browser.send(m, p, sessionId),
  };
  const report = {};
  try {
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: channelUrl });
    await sleep(10000);
    report.href = await evaluate(page, 'location.href');
    report.title = await evaluate(page, 'document.title');
    report.info = await evaluate(
      page,
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) {
            if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          }
          return out;
        }
        var fileInputs = deepAll(document, 'input[type=file]', []);
        var dialog = document.querySelector('ytcp-upload-video-dialog');
        var create = document.querySelector('#create-icon');
        var textbox = deepAll(document, '#textbox', []);
        return {
          lightFileInputs: document.querySelectorAll('input[type=file]').length,
          deepFileInputs: fileInputs.length,
          fileAccepts: fileInputs.map(function (el) { return el.accept; }),
          dialogExists: !!dialog,
          dialogInShadow: dialog ? !!dialog.shadowRoot : null,
          createExists: !!create,
          createTag: create ? create.tagName : '',
          createText: create ? (create.textContent || '').trim().slice(0, 40) : '',
          textboxes: textbox.length,
          dialogHtml: dialog ? dialog.outerHTML.slice(0, 400) : '',
          bodyText: document.body.innerText.slice(0, 300)
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
    browser.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
