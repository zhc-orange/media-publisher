'use strict';

/**
 * 在内容列表里找草稿 → 打开详情页，检查「显示更多/展开 / 标签输入框」。
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
    await tab.webContents.loadURL(`https://studio.youtube.com/channel/${channelId}/videos/upload`);
    await sleep(7000);

    const pageInfo = await tab.webContents.executeJavaScript(
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          return out;
        }
        var links = deepAll(document, 'a[href*="/video/"]', []).map(function (a) { return a.getAttribute('href'); });
        var uniq = [];
        links.forEach(function (h) { if (/\\/video\\/[\\w-]+\\/edit/.test(h) && uniq.indexOf(h) < 0) uniq.push(h); });
        return { url: location.href, links: uniq.slice(0, 5), body: document.body.innerText.slice(0, 300) };
      })()`,
      true
    );
    console.log('LIST', JSON.stringify(pageInfo, null, 2));
    if (!pageInfo.links.length) {
      console.log('没有可用的草稿链接');
      return;
    }
    const href = pageInfo.links[0].startsWith('http') ? pageInfo.links[0] : 'https://studio.youtube.com' + pageInfo.links[0];
    await tab.webContents.loadURL(href);
    await sleep(7000);

    const before = await tab.webContents.executeJavaScript(
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          return out;
        }
        var labels = deepAll(document, '*', []).filter(function (el) {
          var t = String(el.innerText || '').trim();
          return (t === '显示更多' || t === '展开') && el.getBoundingClientRect().width > 0;
        }).slice(0, 6).map(function (el) { return { tag: el.tagName, id: el.id, txt: String(el.innerText || '').trim() }; });
        return {
          url: location.href,
          hasMore: document.body.innerText.indexOf('显示更多') >= 0,
          hasExpand: document.body.innerText.indexOf('展开') >= 0,
          labels: labels,
          tagContainer: deepAll(document, '#tags-container', []).length,
          tagInputs: deepAll(document, '#tags-container input', []).length,
          bodyTail: document.body.innerText.slice(-700)
        };
      })()`,
      true
    );
    console.log('EDIT_BEFORE', JSON.stringify(before, null, 2));

    // 尝试用「显示更多」再「展开」
    for (const label of ['显示更多', '展开']) {
      const hit = await tab.webContents.executeJavaScript(selectors.findScript(['text=' + label]), true);
      console.log('HIT ' + label, JSON.stringify(hit));
      if (hit.found) {
        await tab.webContents.executeJavaScript(selectors.clickHitScript(), true);
        await sleep(1500);
      }
    }
    const after = await tab.webContents.executeJavaScript(
      `(function () {
        function deepAll(root, sel, out) {
          var nodes = root.querySelectorAll ? root.querySelectorAll(sel) : [];
          for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
          var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) deepAll(all[j].shadowRoot, sel, out);
          return out;
        }
        return {
          tagContainer: deepAll(document, '#tags-container', []).length,
          tagInputs: deepAll(document, '#tags-container input', []).length,
          tagsVisible: deepAll(document, '#tags-container input', []).some(function (el) { return el.getBoundingClientRect().width > 0; }),
          bodyTail: document.body.innerText.slice(-500)
        };
      })()`,
      true
    );
    console.log('EDIT_AFTER', JSON.stringify(after, null, 2));
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
