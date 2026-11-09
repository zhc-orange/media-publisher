'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createMockServer } = require('../src/main/mock-server');
const Cdp = require('../src/main/cdp');
const selectors = require('../src/main/selectors');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insp(win, label) {
  const out = await win.webContents.executeJavaScript(
    `(function () {
      const el = document.querySelector('input[data-dsh-file="1"]');
      return {
        files: el && el.files ? Array.from(el.files).map(function (f) { return f.name + ':' + f.size; }) : null,
        inputValue: el ? el.value : null,
        pending: (document.getElementById('pending') || {}).style ? document.getElementById('pending').style.display : 'n/a',
        bodyHasPending: document.body.innerText.indexOf('上传中') >= 0
      };
    })()`,
    true
  );
  console.log(label, JSON.stringify(out));
  return out;
}

async function main() {
  const server = await createMockServer();
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { partition: 'persist:late-debug2' } });
  await win.loadURL(server.url + '?late=8000');
  await sleep(1500);
  const video = path.join(os.tmpdir(), 'late-debug.mp4');
  fs.writeFileSync(video, Buffer.alloc(1024 * 100, 1));
  const marked = await win.webContents.executeJavaScript(selectors.fileInputScript(['input[type=file]'], 'video'), true);
  console.log('MARKED', JSON.stringify(marked));
  const cdp = new Cdp(win.webContents);
  await cdp.enableFileChooserIntercept();
  await cdp.setFileInputFiles('input[data-dsh-file="1"]', [video]);
  await sleep(500);
  await insp(win, 'AFTER_FIRST_500MS');
  await sleep(9000);
  await insp(win, 'AFTER_9S');
  console.log('--- clear ---');
  try {
    await cdp.setFileInputFiles('input[data-dsh-file="1"]', []);
    console.log('clear ok');
  } catch (e) {
    console.log('clear error:', e.message);
  }
  await sleep(300);
  await insp(win, 'AFTER_CLEAR');
  console.log('--- set again ---');
  await cdp.setFileInputFiles('input[data-dsh-file="1"]', [video]);
  await sleep(500);
  await insp(win, 'AFTER_SET_AGAIN');
  await sleep(2000);
  await insp(win, 'AFTER_SET_AGAIN_2S');
  try { fs.unlinkSync(video); } catch (e) {}
  await server.close();
  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
