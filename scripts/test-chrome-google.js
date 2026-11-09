'use strict';

/**
 * 验证 Chrome 通道能通过 Google 的浏览器检查：
 * 在真实 Chrome 里打开 YouTube 登录页，输入一个不存在的邮箱点下一步。
 * 如果返回"找不到账号"= 放行；如果返回"浏览器不安全"= 仍被拒。
 * 用法：electron scripts/test-chrome-google.js
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ChromeChannel = require('../src/main/chrome-channel');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = path.join(app.getPath('temp'), 'mp-chrome-google-test');
  fs.mkdirSync(dataDir, { recursive: true });
  const channel = new ChromeChannel({
    userDataDir: dataDir,
    networkMode: 'system',
    log: (m) => console.log('[chrome]', m),
  });
  const report = {};
  try {
    const tab = await channel.createTab('google-test');
    await tab.navigate('https://studio.youtube.com');
    await sleep(7000);
    report.first = await tab.evaluate('({ url: location.href, title: document.title, body: document.body.innerText.slice(0, 200) })');
    console.log('FIRST', JSON.stringify(report.first, null, 2));

    const filled = await tab.evaluate(
      `(function () {
        const input = document.querySelector('input[name=identifier]');
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'dsh-chrome-probe-9381@example.com');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    );
    const clicked = await tab.evaluate(
      `(function () {
        const next = Array.from(document.querySelectorAll('button')).find(function (b) { return /下一步|Next/.test(b.innerText || ''); });
        if (!next) return false;
        next.click();
        return true;
      })()`
    );
    report.filled = filled;
    report.clicked = clicked;
    await sleep(8000);
    report.after = await tab.evaluate('({ url: location.href, body: document.body.innerText.slice(0, 500) })');
    console.log('AFTER', JSON.stringify(report.after, null, 2));
    const body = report.after.body || '';
    report.verdict = body.indexOf('不安全') >= 0 || body.indexOf('not secure') >= 0
      ? 'BLOCKED'
      : body.indexOf('找不到') >= 0 || body.indexOf("Couldn't find") >= 0
        ? 'ALLOWED'
        : 'UNKNOWN';
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
    console.log('ERROR', report.error);
  } finally {
    fs.writeFileSync(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('GOOGLE_CHROME_TEST=' + (report.verdict || 'FAIL'));
    try {
      await channel.shutdown();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
