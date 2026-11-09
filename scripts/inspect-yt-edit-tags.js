'use strict';

/**
 * 在已有的 YouTube 草稿详情页验证「显示更多 → 标签输入框」链路（不上传新视频）。
 */

const { app } = require('electron');
const path = require('node:path');
const { getPlatform } = require('../src/main/config');
const selectors = require('../src/main/selectors');
const ChromeChannel = require('../src/main/chrome-channel');

app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = path.join(process.env.APPDATA || app.getPath('appData'), '自媒体发布助手');
  const channel = new ChromeChannel({ userDataDir: dataDir, networkMode: 'system', log: () => {} });
  try {
    const platform = getPlatform('youtube');
    const tab = await channel.createTab('youtube');
    await tab.webContents.loadURL(platform.entry);
    await sleep(4000);
    const channelId = await tab.webContents.executeJavaScript(selectors.channelIdScript(), true);
    const listUrl = `https://studio.youtube.com/channel/${channelId}/videos/upload`;
    await tab.webContents.loadURL(listUrl);
    await sleep(6000);
    const links = await tab.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('a[href*="/video/"]')).map(function (a) { return a.getAttribute('href'); }).filter(function (h) { return /\\/video\\/[\\w-]+\\/edit/.test(h); }).slice(0, 5)`,
      true
    );
    console.log('LINKS', JSON.stringify(links));
    if (!links.length) throw new Error('没有找到草稿视频链接');
    const href = links[0].startsWith('http') ? links[0] : 'https://studio.youtube.com' + links[0];
    await tab.webContents.loadURL(href);
    await sleep(7000);
    const before = await tab.webContents.executeJavaScript(
      `(function () {
        var t = document.body.innerText;
        return {
          hasMore: t.indexOf('显示更多') >= 0,
          tagContainer: !!document.querySelector('#tags-container'),
          tagInput: document.querySelectorAll('#tags-container input').length,
          url: location.href,
          title: (document.querySelector('#textbox') && (document.querySelector('#textbox').innerText || document.querySelector('#textbox').value)) || ''
        };
      })()`,
      true
    );
    console.log('BEFORE', JSON.stringify(before, null, 2));
    // 用引擎的文本查找点击「显示更多」
    const hit = await tab.webContents.executeJavaScript(selectors.findScript(['text=显示更多']), true);
    console.log('HIT', JSON.stringify(hit));
    if (hit.found) {
      await tab.webContents.executeJavaScript(selectors.clickHitScript(), true);
      await sleep(1500);
    }
    const after = await tab.webContents.executeJavaScript(
      `(function () {
        return {
          tagContainer: !!document.querySelector('#tags-container'),
          tagInput: document.querySelectorAll('#tags-container input').length,
          tagInputVisible: Array.from(document.querySelectorAll('#tags-container input')).some(function (el) { return el.getBoundingClientRect().width > 0; }),
          tagsText: (document.querySelector('#tags-container') && document.querySelector('#tags-container').innerText) || ''
        };
      })()`,
      true
    );
    console.log('AFTER', JSON.stringify(after, null, 2));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  } finally {
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
