'use strict';

/**
 * 渲染进程与主进程之间的安全桥。渲染层拿不到 Node，只能调用这里暴露的方法。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { TAB_BAR_HEIGHT } = require('../main/constants');

const invoke = async (channel, payload) => {
  const res = await ipcRenderer.invoke(channel, payload);
  if (!res || res.ok !== true) throw new Error((res && res.error) || '操作失败');
  return res.data;
};

const subscribe = (channel, callback) => {
  const handler = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      console.error(`[${channel}] 回调出错`, err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  tabBarHeight: TAB_BAR_HEIGHT,
  appInfo: () => invoke('app:info'),
  pickVideo: () => invoke('video:pick'),
  pickCover: () => invoke('cover:pick'),
  fileStat: (filePath) => invoke('file:stat', { path: filePath }),
  setMedia: (kind, filePath) => invoke('media:set', { kind, path: filePath }),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (err) {
      return '';
    }
  },
  checkVideo: (videoPath) => invoke('video:check', { videoPath }),
  startTask: (task) => invoke('task:start', { task }),
  cancelTask: () => invoke('task:cancel'),
  retryPlatform: (task, platformId) => invoke('task:retry', { task, platformId }),
  taskStatus: () => invoke('task:status'),
  tabsList: () => invoke('tabs:list'),
  showTab: (platformId) => invoke('tab:show', platformId),
  hideTabs: () => invoke('tab:hide'),
  closeTab: (platformId) => invoke('tab:close', platformId),
  reloadTab: (platformId) => invoke('tab:reload', platformId),
  checkLogin: (platformId) => invoke('login:check', platformId),
  scanPage: (platformId) => invoke('page:scan', platformId),
  history: () => invoke('history:list'),
  clearHistory: () => invoke('history:clear'),
  getSettings: () => invoke('settings:get'),
  saveSettings: (settings) => invoke('settings:save', settings),
  openPath: (target) => invoke('shell:open', target),
  openExternal: (url) => invoke('shell:open-external', url),
  revealPath: (target) => invoke('shell:reveal', target),
  onTaskEvent: (callback) => subscribe('task:event', callback),
  onTabs: (callback) => subscribe('tabs:update', callback),
});
