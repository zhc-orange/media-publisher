'use strict';

/**
 * 检查视频号登录页 iframe 内部状态与加载错误。
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');
if (process.env.MP_DIRECT === '1') app.commandLine.appendSwitch('no-proxy-server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  if (process.env.MP_DIRECT === '1') await ses.setProxy({ mode: 'direct' }).catch(() => {});

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: { partition: 'persist:platforms', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => logs.push(level + ': ' + message));
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    logs.push('did-fail-load ' + code + ' ' + desc + ' ' + url + ' main=' + isMainFrame);
  });
  const report = { logs };
  try {
    await win.loadURL('https://channels.weixin.qq.com/login.html').catch((e) => (report.loadError = e.message));
    await sleep(9000);
    const frames = [];
    const walk = async (frame, depth) => {
      const info = { depth, url: frame.url };
      try {
        info.body = await frame.executeJavaScript('document.body ? document.body.innerText.slice(0, 200) : ""');
        info.images = await frame.executeJavaScript(
          'Array.from(document.images).filter(function(i){return i.getBoundingClientRect().width>30}).length'
        );
        info.canvas = await frame.executeJavaScript('document.querySelectorAll("canvas").length');
      } catch (err) {
        info.error = err.message;
      }
      frames.push(info);
      for (const child of frame.frames) await walk(child, depth + 1);
    };
    await walk(win.webContents.mainFrame, 0);
    report.frames = frames;
  } catch (err) {
    report.error = err.message;
  } finally {
    console.log(JSON.stringify(report, null, 2));
    try {
      win.destroy();
    } catch (err) {
      /* ignore */
    }
    app.exit(0);
  }
});
