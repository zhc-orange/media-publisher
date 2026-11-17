'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Runner = require('../src/main/runner');
const { resolveCopy } = Runner;

const en = { id: 'youtube', language: 'en' };
const zh = { id: 'bilibili', language: 'zh' };

const task = {
  title: '室内攀岩',
  description: '中文简介',
  tags: ['室内攀岩'],
  titleEn: 'Indoor Climbing',
  descriptionEn: 'English description',
  tagsEn: ['climbing', 'bouldering'],
};

test('英文优先平台使用英文文案', () => {
  const c = resolveCopy(task, en);
  assert.equal(c.title, 'Indoor Climbing');
  assert.equal(c.desc, 'English description');
  assert.deepEqual(c.tags, ['climbing', 'bouldering']);
  assert.equal(c.usedLanguage, 'en');
  assert.deepEqual(c.fallbackFields, []);
});

test('中文平台忽略英文，即使填了英文', () => {
  const c = resolveCopy(task, zh);
  assert.equal(c.title, '室内攀岩');
  assert.equal(c.desc, '中文简介');
  assert.deepEqual(c.tags, ['室内攀岩']);
  assert.equal(c.usedLanguage, 'zh');
});

test('英文缺失时逐字段回落中文，而不是整条留空', () => {
  const partial = { ...task, titleEn: '', descriptionEn: 'Only desc in English', tagsEn: [] };
  const c = resolveCopy(partial, en);
  assert.equal(c.title, '室内攀岩', '标题回落中文');
  assert.equal(c.desc, 'Only desc in English', '有英文的字段用英文');
  assert.deepEqual(c.tags, ['室内攀岩'], '话题回落中文');
  assert.equal(c.usedLanguage, 'en');
  assert.deepEqual(c.fallbackFields.sort(), ['tags', 'title'].sort());
});

test('完全没填英文时，英文平台也回落到中文', () => {
  const noEn = { title: '标题', description: '简介', tags: ['a'] };
  const c = resolveCopy(noEn, en);
  assert.equal(c.title, '标题');
  assert.equal(c.desc, '简介');
  assert.deepEqual(c.tags, ['a']);
  assert.equal(c.usedLanguage, 'zh');
});

test('英文话题支持逗号分隔字符串', () => {
  const c = resolveCopy({ ...task, tagsEn: 'climbing, bouldering，抱石' }, en);
  assert.deepEqual(c.tags, ['climbing', 'bouldering', '抱石']);
});
