'use strict';

/**
 * 诊断 Google 登录：在 Electron 里打开 Google 登录页，检查浏览器指纹，
 * 并尝试输入一个不存在的邮箱点「下一步」，看 Google 的返回（是否以"浏览器不安全"拒绝）。
 * 用法：electron scripts/probe-google.js [--ua=app]
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const userData = path.join(app.getPath('temp'), 'mp-google-test');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const useAppUa = process.argv.includes('--ua=app');
  const chrome = process.versions.chrome;
  const ses = session.defaultSession;
  if (useAppUa) {
    ses.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
    );
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => console.log('[console]', level, message));

  if (process.argv.includes('--ua=meta')) {
    const meta = {
      brands: [
        { brand: 'Google Chrome', version: '130' },
        { brand: 'Chromium', version: '130' },
        { brand: 'Not?A_Brand', version: '99' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '130.0.6723.191' },
        { brand: 'Chromium', version: '130.0.6723.191' },
        { brand: 'Not?A_Brand', version: '99.0.0.0' },
      ],
      fullVersion: '130.0.6723.191',
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    };
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    dbg
      .sendCommand('Emulation.setUserAgentOverride', {
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`,
        acceptLanguage: 'zh-CN,zh;q=0.9',
        platform: 'Win32',
        userAgentMetadata: meta,
      })
      .then(() => console.log('UA override 已应用'))
      .catch((err) => console.log('UA override 失败:', err.message));
  }

  const outDir = path.join(userData, 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { useAppUa, chrome };

  try {
    await win.loadURL('https://studio.youtube.com');
    await sleep(7000);
    report.fingerprint = await win.webContents.executeJavaScript(
      `({
        ua: navigator.userAgent,
        webdriver: navigator.webdriver,
        uaData: navigator.userAgentData ? JSON.stringify(navigator.userAgentData) : null,
        languages: navigator.languages,
        windowChrome: !!window.chrome,
        plugins: navigator.plugins.length
      })`,
      true
    );
    console.log('FINGERPRINT', JSON.stringify(report.fingerprint, null, 2));

    let body = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 400)', true);
    console.log('--- identifier page ---\n' + body);

    // 输入一个不存在的邮箱并点下一步
    const inputs = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('input')).map(function (el) {
        return { type: el.type, name: el.name, id: el.id, aria: el.getAttribute('aria-label'), placeholder: el.placeholder };
      })`,
      true
    );
    console.log('INPUTS', JSON.stringify(inputs));
    const filled = await win.webContents.executeJavaScript(
      `(function () {
        const input = document.querySelector('input[name=identifier]') || document.querySelector('input[type=email]') || document.querySelector('input[type=text]');
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'dsh-probe-not-exist-9381@example.com');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      true
    );
    console.log('email filled:', filled);
    await sleep(800);
    const clicked = await win.webContents.executeJavaScript(
      `(function () {
        const buttons = Array.from(document.querySelectorAll('button'));
        const next = buttons.find(function (b) { return /下一步|Next/.test(b.innerText || ''); });
        if (!next) return false;
        next.click();
        return true;
      })()`,
      true
    );
    console.log('next clicked:', clicked);
    await sleep(6000);
    report.afterSubmit = await win.webContents.executeJavaScript('({ url: location.href, body: document.body.innerText.slice(0, 700) })', true);
    console.log('--- after submit ---\nURL: ' + report.afterSubmit.url + '\n' + report.afterSubmit.body);
    try {
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, useAppUa ? 'google-appua.png' : 'google-default.png'), shot.toPNG());
    } catch (err) {
      /* ignore */
    }
  } catch (err) {
    report.error = err.message;
    console.log('ERROR', err.message);
  } finally {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    try {
      win.destroy();
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
