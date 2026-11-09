'use strict';

/**
 * 平台配置加载与校验。
 * 新增平台只需在 src/config/platforms/ 下放一个 json，不需要改代码。
 */

const fs = require('node:fs');
const path = require('node:path');

const PLATFORM_DIR = path.join(__dirname, '..', 'config', 'platforms');
const TAGS_MODES = ['inline-hash', 'comma-input', 'enter-input', 'none'];

let cache = null;

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function validatePlatform(raw, file) {
  const fail = (msg) => {
    throw new Error(`平台配置 ${file} 不合法：${msg}`);
  };
  if (!raw || typeof raw !== 'object') fail('内容必须是对象');
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9_-]+$/.test(id)) fail('id 只能包含小写字母、数字、-、_');
  const name = String(raw.name || '').trim();
  if (!name) fail('缺少 name');
  const entry = String(raw.entry || '').trim();
  if (!/^https?:\/\//.test(entry)) fail('entry 必须是 http(s) 地址');

  const title = asArray(raw.title && raw.title.selectors);
  if (!title.length) fail('title.selectors 不能为空');

  const content = asArray(raw.content && raw.content.selectors);
  const tags = raw.tags || {};
  const tagsMode = tags.mode || 'none';
  if (!TAGS_MODES.includes(tagsMode)) fail(`tags.mode 必须是 ${TAGS_MODES.join(' / ')}`);

  const videoInput = asArray(raw.video && raw.video.input);
  if (!videoInput.length) fail('video.input 不能为空');

  const limits = raw.limits || {};
  for (const key of ['title', 'description', 'tags', 'maxFileMB']) {
    if (limits[key] != null && !(Number.isFinite(Number(limits[key])) && Number(limits[key]) > 0)) {
      fail(`limits.${key} 必须是正数`);
    }
  }

  return {
    id,
    name,
    nameEn: String(raw.nameEn || ''),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 99,
    entry,
    engine: raw.engine === 'chrome' ? 'chrome' : 'electron',
    uploadEntry: String(raw.uploadEntry || ''),
    combineTitleDesc: raw.combineTitleDesc === true,
    note: String(raw.note || ''),
    noteEn: String(raw.noteEn || ''),
    limits: {
      title: Number(limits.title || 30),
      description: Number(limits.description || 1000),
      tags: Number(limits.tags || 10),
      maxFileMB: Number(limits.maxFileMB || 4096),
    },
    loginCheck: {
      selectors: asArray(raw.loginCheck && raw.loginCheck.selectors),
      rejectTexts: asArray(raw.loginCheck && raw.loginCheck.rejectTexts),
      urlIncludes: (raw.loginCheck && raw.loginCheck.urlIncludes) || '',
      urlExcludes: (raw.loginCheck && raw.loginCheck.urlExcludes) || '',
      timeoutMs: Number((raw.loginCheck && raw.loginCheck.timeoutMs) || 600000),
    },
    video: {
      openButton: asArray(raw.video && raw.video.openButton),
      readyTexts: asArray(raw.video && raw.video.readyTexts),
      input: videoInput,
      accept: String((raw.video && raw.video.accept) || 'video'),
      initialWaitMs: Number((raw.video && raw.video.initialWaitMs) || 2500),
      timeoutMs: Number((raw.video && raw.video.timeoutMs) || 180000),
    },
    title: { selectors: title, clearFirst: !(raw.title && raw.title.clearFirst === false) },
    content: { selectors: content, clearFirst: !(raw.content && raw.content.clearFirst === false) },
    tags: {
      mode: tagsMode,
      selectors: asArray(tags.selectors),
      openButton: asArray(tags.openButton),
      prefix: tags.prefix == null ? '#' : String(tags.prefix),
      confirm: tags.confirm !== false,
    },
    cover: {
      optional: raw.cover ? raw.cover.optional !== false : true,
      input: asArray(raw.cover && raw.cover.input),
      openButton: asArray(raw.cover && raw.cover.openButton),
    },
    upload: {
      doneSelectors: asArray(raw.upload && raw.upload.doneSelectors),
      pendingTexts: asArray(raw.upload && raw.upload.pendingTexts).length
        ? asArray(raw.upload.pendingTexts)
        : ['上传中', '正在上传', '处理中', '转码中'],
      timeoutMs: Number((raw.upload && raw.upload.timeoutMs) || 1800000),
      stallTimeoutMs: Number((raw.upload && raw.upload.stallTimeoutMs) || 180000),
    },
    publishButton: asArray(raw.publishButton),
  };
}

function loadPlatforms({ force = false } = {}) {
  if (cache && !force) return cache;
  if (!fs.existsSync(PLATFORM_DIR)) throw new Error(`平台配置目录不存在：${PLATFORM_DIR}`);
  const files = fs.readdirSync(PLATFORM_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  const list = files.map((f) => {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(PLATFORM_DIR, f), 'utf8'));
    } catch (err) {
      throw new Error(`平台配置 ${f} 解析失败：${err.message}`);
    }
    return validatePlatform(raw, f);
  });
  list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  cache = list;
  return list;
}

function getPlatform(id) {
  const found = loadPlatforms().find((p) => p.id === id);
  if (!found) throw new Error(`未知平台：${id}`);
  return found;
}

module.exports = { loadPlatforms, getPlatform, validatePlatform, PLATFORM_DIR };
