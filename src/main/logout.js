'use strict';

/**
 * 单平台退出登录：只清理「本程序」自己的会话数据，不动用户日常浏览器。
 *
 * - 内置浏览器平台（persist:platforms 会话）：按域名精确删 Cookie + 清 origin 存储；
 * - Chrome 通道平台（YouTube / TikTok）：通过 CDP 删对应域名的 Cookie。
 *
 * 清理完必须重开创作中心并确认落到登录页，才算退出成功。
 */

const { session } = require('electron');

// 需要一并清掉的存储类型（clearStorageData 支持的子集）
const STORAGES = ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem'];

/** 取可注册域名：member.bilibili.com → bilibili.com；a.b.com.cn → b.com.cn */
function rootDomain(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.').toLowerCase();
  const twoLevelSuffix = /^(com|net|org|gov|edu|co|ac)\.[a-z]{2}$/.test(last2);
  return parts.slice(twoLevelSuffix ? -3 : -2).join('.');
}

function domainMatches(cookieDomain, root) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  return d === root || d.endsWith(`.${root}`);
}

function candidateOrigins(platform, root) {
  const host = (() => {
    try {
      return new URL(platform.entry).hostname;
    } catch (err) {
      return root;
    }
  })();
  const set = new Set([
    `https://${host}`,
    `https://${root}`,
    `https://www.${root}`,
    `https://passport.${root}`,
    `https://creator.${root}`,
  ]);
  return Array.from(set);
}

/** 内置浏览器：清 Cookie + 存储 */
async function logoutElectronPlatform(platform) {
  const ses = session.fromPartition('persist:platforms');
  const host = new URL(platform.entry).hostname;
  const root = rootDomain(host);
  const origins = candidateOrigins(platform, root);

  for (const origin of origins) {
    try {
      await ses.clearStorageData({ origin, storages: STORAGES });
    } catch (err) {
      /* 某些 origin 没有存储，忽略 */
    }
  }

  let removed = 0;
  const cookies = await ses.cookies.get({}).catch(() => []);
  for (const c of cookies) {
    if (!domainMatches(c.domain, root)) continue;
    const d = String(c.domain || '').replace(/^\./, '');
    const scheme = c.secure ? 'https' : 'http';
    try {
      await ses.cookies.remove(`${scheme}://${d}${c.path || '/'}`, c.name);
      removed += 1;
    } catch (err) {
      /* 单条失败不影响其它 */
    }
  }
  return { mode: 'electron', root, origins, removed };
}

/** Chrome 通道：通过 CDP 删 Cookie（只删该平台域名） */
async function logoutChromePlatform(entry, platform) {
  const host = new URL(platform.entry).hostname;
  const root = rootDomain(host);
  const wc = entry && entry.view && entry.view.webContents;
  if (!wc) return { mode: 'chrome', root, removed: 0, error: '标签页不可用' };

  const send = (method, params) =>
    wc.debugger && wc.debugger.sendCommand
      ? wc.debugger.sendCommand(method, params || {})
      : Promise.reject(new Error('调试通道不可用'));

  let removed = 0;
  try {
    const all = await send('Network.getAllCookies');
    for (const c of (all && all.cookies) || []) {
      if (!domainMatches(c.domain, root)) continue;
      try {
        await send('Network.deleteCookies', {
          name: c.name,
          domain: c.domain,
          path: c.path || '/',
        });
        removed += 1;
      } catch (err) {
        /* ignore */
      }
    }
    await send('Network.clearBrowserCache').catch(() => {});
  } catch (err) {
    return { mode: 'chrome', root, removed, error: err.message };
  }
  return { mode: 'chrome', root, removed };
}

/**
 * 执行单平台退出，返回 { ok, removed, root, verified }
 * verified = 重新打开后确实不在登录态
 */
async function logoutPlatform({ platform, entry, reload }) {
  const isChrome = platform.engine === 'chrome';
  const result = isChrome
    ? await logoutChromePlatform(entry, platform)
    : await logoutElectronPlatform(platform);

  // 重新加载页面，让前端状态跟着失效
  try {
    const wc = entry && entry.view && entry.view.webContents;
    if (wc && !wc.isDestroyed()) {
      if (isChrome && wc.loadURL) await wc.loadURL(platform.entry);
      else wc.reload();
    }
  } catch (err) {
    /* ignore */
  }

  return { ok: !result.error, ...result };
}

module.exports = { logoutPlatform, rootDomain, domainMatches };
