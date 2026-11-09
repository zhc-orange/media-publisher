'use strict';

/**
 * 能力探测：Electron 主进程里能否 WebSocket（Chrome CDP 通道需要）。
 */

const { app } = require('electron');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('invalid json: ' + data.slice(0, 120)));
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  const report = {
    node: process.versions.node,
    electron: process.versions.electron,
    globalWebSocket: typeof WebSocket,
    fetch: typeof fetch,
  };

  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  report.chromeExists = fs.existsSync(chrome);
  if (report.chromeExists) {
    const profile = path.join(app.getPath('temp'), 'mp-chrome-cdp-test');
    fs.mkdirSync(profile, { recursive: true });
    const port = 9333;
    const child = spawn(chrome, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--proxy-server=',
      'about:blank',
    ]);
    report.chromePid = child.pid;
    let version = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        version = await getJson(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch (e) {
        /* retry */
      }
    }
    report.cdpVersion = version;
    if (version) {
      // 尝试建立 WebSocket 并执行一次 Runtime.evaluate
      try {
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('ws timeout')), 8000);
          ws.onopen = () => {
            ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
          };
          ws.onmessage = (ev) => {
            clearTimeout(timer);
            resolve(JSON.parse(ev.data));
          };
          ws.onerror = (e) => {
            clearTimeout(timer);
            reject(new Error('ws error'));
          };
        });
        report.wsWorks = true;
        report.targets = (result.result && result.result.targetInfos ? result.result.targetInfos.length : null);
        ws.close();
      } catch (err) {
        report.wsWorks = false;
        report.wsError = err.message;
      }
    }
    try {
      child.kill();
    } catch (e) {
      /* ignore */
    }
  }

  fs.writeFileSync(path.join(app.getPath('temp'), 'mp-cdp-capability.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
