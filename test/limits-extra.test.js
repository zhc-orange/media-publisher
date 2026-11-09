'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareForPlatform, countChars, truncateChars, inlineTags } = require('../src/main/limits');

test('countChars/truncateChars 按码点处理 emoji', () => {
  assert.equal(countChars('😀😀😀'), 3);
  assert.equal(truncateChars('😀😀😀', 2), '😀😀');
});

test('prepareForPlatform 用码点判断标题超限', () => {
  const platform = { name: '测试', limits: { title: 3, description: 10, tags: 5, maxFileMB: 100 }, tags: { mode: 'none' } };
  const out = prepareForPlatform({ title: '😀😀😀😀', description: '', tags: [] }, platform, { autoTruncate: true });
  assert.equal(countChars(out.title), 3);
  assert.equal(out.errors.length, 0);
});

test('inline-hash 平台正文预算包含话题', () => {
  const platform = {
    name: '测试',
    limits: { title: 30, description: 12, tags: 5, maxFileMB: 100 },
    tags: { mode: 'inline-hash', prefix: '#' },
  };
  const out = prepareForPlatform({ title: 't', description: 'A'.repeat(10), tags: ['x'] }, platform, { autoTruncate: true });
  const total = countChars(out.description) + 1 + countChars(inlineTags(out.tags, '#'));
  assert.ok(total <= 12, `正文+话题应不超过 12，实际 ${total}`);
  assert.ok(out.warnings.some((w) => w.indexOf('正文加话题') >= 0));
});
