'use strict';

/**
 * IPC 通道：渲染进程唯一能触达主进程的入口，全部做参数校验与错误包装。
 */

const { ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { loadPlatforms, getPlatform } = require('./config');
const { checkVideo, VIDEO_EXTENSIONS } = require('./limits');
const selectors = require('./selectors');
const diagnostics = require('./diagnostics');
const { saveSettings } = require('./settings');
const { TAB_BAR_HEIGHT } = require('./constants');
const mediaStore = require('./media-store');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO_FILTERS = [
  { name: '视频文件', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'flv', 'wmv', 'webm'] },
  { name: '所有文件', extensions: ['*'] },
];

function registerIpc(ctx) {
  const { app, dirs, tabs, runner, getSettings, setSettings, getWindow } = ctx;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return { ok: true, data: await fn(payload, event) };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });
  };

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    dirs,
    tabBarHeight: TAB_BAR_HEIGHT,
    running: runner.isRunning,
    platforms: loadPlatforms().map((p) => ({
      id: p.id,
      name: p.name,
      nameEn: p.nameEn,
      note: p.note,
      noteEn: p.noteEn,
      order: p.order,
      entry: p.entry,
      engine: p.engine,
      limits: p.limits,
      tagsMode: p.tags.mode,
    })),
  }));

  handle('video:pick', async () => {
    const settings = getSettings();
    const res = await dialog.showOpenDialog(getWindow(), {
      title: '选择要发布的视频',
      defaultPath: settings.lastVideoDir || undefined,
      properties: ['openFile'],
      filters: VIDEO_FILTERS,
    });
    if (res.canceled || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    setSettings(saveSettings(dirs, { ...settings, lastVideoDir: path.dirname(filePath) }));
    mediaStore.set('video', filePath);
    const stat = fs.statSync(filePath);
    return { path: filePath, name: path.basename(filePath), sizeMB: Number((stat.size / 1048576).toFixed(1)) };
  });

  handle('cover:pick', async () => {
    const settings = getSettings();
    const res = await dialog.showOpenDialog(getWindow(), {
      title: '选择封面图（可选）',
      defaultPath: settings.lastCoverDir || undefined,
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    setSettings(saveSettings(dirs, { ...settings, lastCoverDir: path.dirname(filePath) }));
    mediaStore.set('cover', filePath);
    return { path: filePath, name: path.basename(filePath) };
  });

  handle('file:stat', (payload) => {
    const filePath = payload && payload.path;
    if (!filePath) throw new Error('缺少文件路径');
    const resolved = path.resolve(String(filePath));
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('不是文件');
    return {
      path: resolved,
      name: path.basename(resolved),
      ext: path.extname(resolved).toLowerCase(),
      sizeMB: Number((stat.size / 1048576).toFixed(1)),
    };
  });

  handle('media:set', (payload) => {
    const kind = payload && payload.kind;
    const filePath = payload && payload.path;
    if (!filePath) return mediaStore.set(kind, '');
    const resolved = path.resolve(String(filePath));
    const ext = path.extname(resolved).toLowerCase();
    if (kind === 'video' && !VIDEO_EXTENSIONS.includes(ext)) throw new Error(`不支持的视频格式：${ext}`);
    if (kind === 'cover' && !['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) {
      throw new Error(`不支持的图片格式：${ext}`);
    }
    if (!fs.existsSync(resolved)) throw new Error('文件不存在');
    return mediaStore.set(kind, resolved);
  });

  handle('video:check', (payload) => {
    const videoPath = payload && payload.videoPath;
    const platforms = loadPlatforms();
    return {
      platforms: platforms.map((p) => {
        const check = checkVideo(videoPath, p);
        return { id: p.id, name: p.name, ok: check.ok, sizeMB: check.sizeMB, maxFileMB: p.limits.maxFileMB, errors: check.errors };
      }),
    };
  });

  handle('task:start', (payload) => {
    const task = payload && payload.task;
    if (!task) throw new Error('缺少任务参数');
    if (!task.videoPath) throw new Error('请先选择视频文件');
    if (!Array.isArray(task.platforms) || !task.platforms.length) throw new Error('请至少勾选一个平台');
    if (!String(task.title || '').trim()) throw new Error('标题不能为空');
    if (runner.isRunning) throw new Error('已有任务正在执行，请等待完成或先取消');
    loadPlatforms();
    // 去重并校验：同一平台不能被两个 worker 同时操作
    const ids = [...new Set(task.platforms.filter((id) => typeof id === 'string' && id))];
    if (!ids.length) throw new Error('请至少勾选一个平台');
    ids.forEach((id) => getPlatform(id));

    const newTask = { ...task, platforms: ids, id: task.id || `t${Date.now()}` };
    runner
      .runTask(newTask)
      .catch((err) => {
        send('task:event', { type: 'fatal', message: err.message || String(err) });
      });
    return { taskId: newTask.id };
  });

  handle('task:cancel', () => ({ cancelled: runner.cancel() }));

  handle('task:retry', (payload) => {
    const task = payload && payload.task;
    const platformId = payload && payload.platformId;
    if (!task || !platformId) throw new Error('缺少重试参数');
    getPlatform(platformId);
    if (!task.videoPath) throw new Error('缺少视频文件，请先重新选择');
    if (runner.isRunning) {
      return runner.enqueueRetry(task, platformId);
    }
    const newTask = { ...task, id: `t${Date.now()}`, platforms: [platformId] };
    runner
      .runTask(newTask)
      .catch((err) => {
        send('task:event', { type: 'fatal', message: err.message || String(err) });
      });
    return { taskId: newTask.id, queued: false };
  });

  handle('task:status', () => ({ running: runner.isRunning }));

  handle('tabs:list', () => tabs.list());

  handle('tab:show', async (platformId) => {
    const platform = getPlatform(platformId);
    const entry = await tabs.ensure(platform);
    await tabs.show(platformId);
    const wc = entry.view.webContents;
    const url = wc.getURL() || '';
    if (!url || url === 'about:blank') await wc.loadURL(platform.entry).catch(() => {});
    return tabs.list();
  });

  handle('tab:hide', () => {
    tabs.hide();
    return tabs.list();
  });

  handle('tab:close', async (platformId) => {
    if (platformId) await tabs.close(platformId);
    return tabs.list();
  });

  handle('tab:reload', async (platformId) => {
    if (runner.isRunning) throw new Error('任务执行中，暂不能刷新页面');
    const platform = getPlatform(platformId);
    const entry = await tabs.ensure(platform);
    const wc = entry.view.webContents;
    wc.reload();
    return { ok: true, url: wc.getURL() };
  });

  handle('login:check', async (platformId) => {
    const platform = getPlatform(platformId);
    const entry = await tabs.ensure(platform);
    await tabs.show(platformId);
    const wc = entry.view.webContents;
    const startUrl = wc.getURL() || '';
    if (!startUrl || startUrl === 'about:blank') await wc.loadURL(platform.entry).catch(() => {});
    const check = platform.loginCheck;
    if (!check.selectors.length && !check.rejectTexts.length) {
      tabs.setStatus(platformId, 'idle', '未配置登录检测');
      return { known: false, loggedIn: null, url: wc.getURL(), message: '该平台未配置登录检测规则' };
    }
    const deadline = Date.now() + 25000;
    let last = { loggedIn: false, rejectHits: [], hasFileInput: false, url: wc.getURL() };
    const isLoggedIn = (st) => selectors.judgeLogin(st, check);
    while (Date.now() < deadline) {
      last = await wc
        .executeJavaScript(selectors.loginStateScript(check.selectors, check.urlExcludes, check.rejectTexts), true)
        .catch(() => ({ loggedIn: false, rejectHits: [], hasFileInput: false, url: wc.getURL() }));
      if (isLoggedIn(last)) break;
      await sleep(1200);
    }
    if (isLoggedIn(last)) {
      tabs.setStatus(platformId, 'idle', '已登录');
      return { known: true, loggedIn: true, url: last.url };
    }
    tabs.setStatus(platformId, 'need_login', '未登录');
    const reject = (last.rejectHits || [])[0];
    return {
      known: true,
      loggedIn: false,
      url: last.url,
      message: reject
        ? `页面提示需要登录（${reject}），请在该标签页完成登录后重新检测`
        : '未检测到登录状态，请在该标签页完成登录后重新检测',
    };
  });

  handle('page:scan', async (platformId) => {
    const platform = getPlatform(platformId);
    const entry = await tabs.ensure(platform);
    await tabs.show(platformId);
    const data = await diagnostics.collect(entry.view, { platformId, platformName: platform.name, step: 'manual' });
    const file = diagnostics.save(dirs.diagnostics, `scan-${platformId}-${Date.now()}`, data);
    const page = data.page || {};
    return {
      file,
      url: page.url || '',
      fields: Array.isArray(page.fields) ? page.fields.length : 0,
      buttons: Array.isArray(page.buttons) ? page.buttons.length : 0,
      fileInputs: page.fileInputCount || 0,
    };
  });

  handle('history:list', () => {
    try {
      const raw = JSON.parse(fs.readFileSync(dirs.tasksFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch (err) {
      return [];
    }
  });

  handle('history:clear', () => {
    try {
      fs.unlinkSync(dirs.tasksFile);
    } catch (err) {
      /* ignore */
    }
    return { cleared: true };
  });

  handle('settings:get', () => getSettings());

  handle('settings:save', (payload) => {
    const patch = { ...(payload || {}) };
    if ('concurrency' in patch) {
      const n = Number(patch.concurrency);
      if (![0, 1, 2, 3].includes(n)) throw new Error('并发数只能是 0 / 1 / 2 / 3');
      patch.concurrency = n;
    }
    if ('networkMode' in patch && !['system', 'direct'].includes(patch.networkMode)) {
      throw new Error('网络模式只能是 system / direct');
    }
    if ('language' in patch && !['system', 'zh', 'en'].includes(patch.language)) {
      throw new Error('语言只能是 system / zh / en');
    }
    if ('theme' in patch && !['system', 'light', 'dark'].includes(patch.theme)) {
      throw new Error('主题只能是 system / light / dark');
    }
    for (const key of ['autoTruncate', 'openTabsWhileRunning', 'restoreDraft']) {
      if (key in patch) patch[key] = !!patch[key];
    }
    const next = saveSettings(dirs, { ...getSettings(), ...patch });
    setSettings(next);
    return next;
  });

  handle('shell:open', async (target) => {
    if (!target) throw new Error('缺少路径');
    const resolved = path.resolve(String(target));
    if (!fs.existsSync(resolved)) throw new Error(`路径不存在：${resolved}`);
    const result = await shell.openPath(resolved);
    if (result) throw new Error(result);
    return { opened: resolved };
  });

  handle('shell:open-external', async (url) => {
    if (!/^https?:\/\//.test(String(url || ''))) throw new Error('只允许打开 http(s) 链接');
    await shell.openExternal(String(url));
    return { opened: url };
  });

  handle('shell:reveal', (target) => {
    if (!target) throw new Error('缺少路径');
    shell.showItemInFolder(path.resolve(String(target)));
    return { revealed: target };
  });
}

module.exports = registerIpc;
