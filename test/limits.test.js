'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const limits = require('../src/main/limits');

const platform = {
  id: 'demo',
  name: '演示平台',
  limits: { title: 10, description: 20, tags: 2, maxFileMB: 1 },
};

test('normalizeTags 去重、去 #、过滤空白', () => {
  assert.deepEqual(limits.normalizeTags(['#旅行', ' 旅行 ', '美食', '', '#美食']), ['旅行', '美食']);
  assert.deepEqual(limits.normalizeTags('a, b，c、d;e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(limits.normalizeTags(null), []);
});

test('prepareForPlatform 超长自动截断并给出警告', () => {
  const result = limits.prepareForPlatform(
    { title: '一二三四五六七八九十十一', description: 'x'.repeat(30), tags: ['a', 'b', 'c'] },
    platform,
    { autoTruncate: true }
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.title, '一二三四五六七八九十');
  assert.equal(result.description.length, 20);
  assert.equal(result.tags.length, 2);
  assert.ok(result.warnings.some((w) => w.includes('标题上限')));
});

test('prepareForPlatform 关闭自动截断时超长视为错误', () => {
  const result = limits.prepareForPlatform({ title: '一二三四五六七八九十十一' }, platform, { autoTruncate: false });
  assert.ok(result.errors.some((e) => e.includes('标题超过')));
});

test('prepareForPlatform 空标题报错', () => {
  const result = limits.prepareForPlatform({ title: '   ' }, platform);
  assert.ok(result.errors.includes('标题不能为空'));
});

test('inlineTags 生成 # 话题串', () => {
  assert.equal(limits.inlineTags(['旅行', 'Vlog'], '#'), '#旅行 #Vlog');
  assert.equal(limits.inlineTags([], '#'), '');
});

test('checkVideo 处理不存在的文件与合法文件', () => {
  const missing = limits.checkVideo(path.join(os.tmpdir(), '不存在的视频-xyz.mp4'), platform);
  assert.equal(missing.ok, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
  const file = path.join(dir, 'demo.mp4');
  fs.writeFileSync(file, Buffer.alloc(1024 * 100));
  const ok = limits.checkVideo(file, { ...platform, limits: { ...platform.limits, maxFileMB: 1 } });
  assert.equal(ok.ok, true);
  assert.ok(ok.sizeMB > 0);

  const tooBig = limits.checkVideo(file, { ...platform, limits: { ...platform.limits, maxFileMB: 0.01 } });
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.errors.some((e) => e.includes('上限')));

  const wrongExt = path.join(dir, 'demo.txt');
  fs.writeFileSync(wrongExt, 'x');
  assert.ok(limits.checkVideo(wrongExt, platform).errors.some((e) => e.includes('不支持的视频格式')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preflight 汇总每个平台的问题', () => {
  const result = limits.preflight(
    { videoPath: '', title: '测试标题', description: '', tags: [] },
    [platform, { ...platform, id: 'p2', name: '平台2', limits: { title: 2, description: 20, tags: 2, maxFileMB: 1 } }]
  );
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.errors.length > 0));
});
