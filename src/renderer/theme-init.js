'use strict';

/**
 * 首帧主题：在任何样式表生效前，根据上次选择确定浅色/深色，避免闪白。
 * 真正的主题以主进程 settings 为准，随后由 app.js 覆盖。
 */

(function () {
  var pref = 'system';
  try {
    pref = localStorage.getItem('media-publisher-theme') || 'system';
  } catch (err) {
    pref = 'system';
  }
  var dark = pref === 'dark';
  if (pref !== 'light' && pref !== 'dark') {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
