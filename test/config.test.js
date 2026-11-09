'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadPlatforms, validatePlatform } = require('../src/main/config');

test('内置平台配置全部合法且 id 唯一', () => {
  const list = loadPlatforms({ force: true });
  assert.ok(list.length >= 6, `平台数量不足：${list.length}`);
  const ids = list.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '平台 id 重复');
  for (const p of list) {
    assert.ok(p.name);
    assert.ok(/^https?:\/\//.test(p.entry));
    assert.ok(p.title.selectors.length > 0);
    assert.ok(p.video.input.length > 0);
    assert.ok(p.limits.title > 0);
    assert.ok(['inline-hash', 'comma-input', 'enter-input', 'none'].includes(p.tags.mode));
  }
  for (const id of ['douyin', 'kuaishou', 'bilibili', 'xiaohongshu', 'youtube', 'tiktok']) {
    assert.ok(ids.includes(id), `缺少平台配置：${id}`);
  }
});

test('平台顺序按 order 排序', () => {
  const list = loadPlatforms();
  const orders = list.map((p) => p.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test('抖音上传等待配置：转码不算上传中，且有停滞超时', () => {
  const douyin = loadPlatforms().find((p) => p.id === 'douyin');
  assert.ok(douyin);
  // 「预览转码中」不应被当成「仍在上传」，否则会等到超时
  assert.ok(!douyin.upload.pendingTexts.some((t) => t.includes('转码')));
  assert.ok(!douyin.upload.pendingTexts.some((t) => t === '处理中'));
  assert.equal(douyin.upload.stallTimeoutMs, 180000);
  assert.ok(douyin.title.selectors.some((s) => s.includes('填写作品标题')));
});

test('validatePlatform 拒绝非法配置', () => {
  assert.throws(() => validatePlatform({ id: 'Bad Id', name: 'x', entry: 'https://a' }, 'bad.json'), /id/);
  assert.throws(() => validatePlatform({ id: 'ok', name: 'x', entry: 'ftp://a' }, 'bad.json'), /entry/);
  assert.throws(
    () => validatePlatform({ id: 'ok', name: 'x', entry: 'https://a', title: { selectors: [] } }, 'bad.json'),
    /title/
  );
  assert.throws(
    () =>
      validatePlatform(
        { id: 'ok', name: 'x', entry: 'https://a', title: { selectors: ['#t'] }, video: { input: [] } },
        'bad.json'
      ),
    /video/
  );
  assert.throws(
    () =>
      validatePlatform(
        {
          id: 'ok',
          name: 'x',
          entry: 'https://a',
          title: { selectors: ['#t'] },
          video: { input: ['input'] },
          tags: { mode: 'weird' },
        },
        'bad.json'
      ),
    /tags.mode/
  );
});

test('validatePlatform 补齐默认值', () => {
  const p = validatePlatform(
    {
      id: 'demo',
      name: '演示',
      entry: 'https://example.com/upload',
      title: { selectors: ['input'] },
      video: { input: ['input[type=file]'] },
    },
    'demo.json'
  );
  assert.equal(p.tags.mode, 'none');
  assert.equal(p.loginCheck.timeoutMs, 600000);
  assert.equal(p.upload.timeoutMs, 1800000);
  assert.equal(p.limits.title, 30);
  assert.deepEqual(p.video.openButton, []);
});
