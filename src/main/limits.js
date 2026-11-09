'use strict';

/**
 * 平台限额校验与文案准备（纯逻辑，便于单元测试）。
 */

const fs = require('node:fs');
const path = require('node:path');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.flv', '.wmv', '.webm'];

const FALLBACK_LIMITS = {
  title: 30,
  description: 1000,
  tags: 10,
  maxFileMB: 4096,
};

/** 按 Unicode 码点计数（与渲染层 Array.from 口径一致） */
function countChars(value) {
  return Array.from(String(value == null ? '' : value)).length;
}

/** 按 Unicode 码点截断 */
function truncateChars(value, limit) {
  return Array.from(String(value == null ? '' : value)).slice(0, Math.max(0, limit)).join('');
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[\s,，、;；]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function effectiveLimits(platform) {
  return { ...FALLBACK_LIMITS, ...((platform && platform.limits) || {}) };
}

/**
 * 校验视频文件是否存在/可读/在平台大小限制内。
 * 返回 { ok, sizeMB, errors }
 */
function checkVideo(videoPath, platform) {
  const limits = effectiveLimits(platform);
  const errors = [];
  if (!videoPath) return { ok: false, sizeMB: 0, errors: ['请先选择视频文件'] };
  let stat;
  try {
    stat = fs.statSync(videoPath);
  } catch (err) {
    return { ok: false, sizeMB: 0, errors: [`视频文件无法读取：${err.message}`] };
  }
  if (!stat.isFile()) errors.push('所选路径不是文件');
  const ext = path.extname(String(videoPath)).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) errors.push(`不支持的视频格式 ${ext || '(无扩展名)'}，支持：${VIDEO_EXTENSIONS.join(' ')}`);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > limits.maxFileMB) {
    errors.push(`视频 ${sizeMB.toFixed(0)}MB 超过${platform ? platform.name : '平台'}上限 ${limits.maxFileMB}MB`);
  }
  return { ok: errors.length === 0, sizeMB, errors };
}

/**
 * 按某个平台的限制准备文案：超长时自动截断并给出警告。
 * options.autoTruncate=false 时超长视为错误。
 */
function prepareForPlatform(task, platform, options = {}) {
  const autoTruncate = options.autoTruncate !== false;
  const limits = effectiveLimits(platform);
  const warnings = [];
  const errors = [];
  const name = (platform && platform.name) || '平台';

  let title = normalizeText(task && task.title);
  let description = normalizeText(task && task.description);
  let tags = normalizeTags(task && task.tags);

  if (!title) errors.push('标题不能为空');
  if (countChars(title) > limits.title) {
    warnings.push(`${name}标题上限 ${limits.title} 字，当前 ${countChars(title)} 字`);
    if (autoTruncate) {
      title = truncateChars(title, limits.title);
      warnings.push('已自动截断标题');
    } else {
      errors.push(`${name}标题超过 ${limits.title} 字`);
    }
  }

  if (countChars(description) > limits.description) {
    warnings.push(`${name}简介上限 ${limits.description} 字，当前 ${countChars(description)} 字`);
    if (autoTruncate) {
      description = truncateChars(description, limits.description);
      warnings.push('已自动截断简介');
    } else {
      errors.push(`${name}简介超过 ${limits.description} 字`);
    }
  }

  if (tags.length > limits.tags) {
    warnings.push(`${name}最多 ${limits.tags} 个话题，已保留前 ${limits.tags} 个`);
    tags = tags.slice(0, limits.tags);
  }

  // inline-hash 平台：话题会追加到正文末尾，正文预算要把这段算进去
  // 标题与正文共用同一个输入框的平台，还要再扣掉标题+换行
  const tagMode = platform && platform.tags ? platform.tags.mode : '';
  const titleCost = platform && platform.combineTitleDesc ? countChars(title) + 1 : 0;
  if (tagMode === 'inline-hash' && tags.length) {
    const prefix = (platform.tags && platform.tags.prefix) || '#';
    const suffix = ' ' + inlineTags(tags, prefix);
    const room = Math.max(0, limits.description - titleCost - countChars(suffix));
    if (countChars(description) > room) {
      warnings.push(`${name}正文加话题超过 ${limits.description} 字，已截断正文`);
      description = truncateChars(description, room);
    }
  }

  return { title, description, tags, warnings, errors, limits };
}

/** 话题文本拼接：inline-hash 模式在正文后追加 " #a #b" */
function inlineTags(tags, prefix = '#') {
  const list = normalizeTags(tags);
  if (!list.length) return '';
  return list.map((t) => `${prefix}${t}`).join(' ');
}

/**
 * 对选中平台整体预检，返回每个平台的结果，供界面一次性展示。
 */
function preflight(task, platforms, options = {}) {
  const video = checkVideo(task && task.videoPath, platforms[0]);
  const results = platforms.map((platform) => {
    const prepared = prepareForPlatform(task, platform, options);
    const errors = [...prepared.errors];
    const videoCheck = checkVideo(task && task.videoPath, platform);
    if (!videoCheck.ok) errors.push(...videoCheck.errors);
    return { platformId: platform.id, name: platform.name, errors, warnings: prepared.warnings, prepared };
  });
  return { video, results };
}

module.exports = {
  VIDEO_EXTENSIONS,
  FALLBACK_LIMITS,
  normalizeText,
  normalizeTags,
  effectiveLimits,
  countChars,
  truncateChars,
  checkVideo,
  prepareForPlatform,
  inlineTags,
  preflight,
};
