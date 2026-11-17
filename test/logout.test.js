'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rootDomain, domainMatches } = require('../src/main/logout');

test('rootDomain 取可注册域名', () => {
  assert.equal(rootDomain('member.bilibili.com'), 'bilibili.com');
  assert.equal(rootDomain('creator.douyin.com'), 'douyin.com');
  assert.equal(rootDomain('channels.weixin.qq.com'), 'qq.com');
  assert.equal(rootDomain('studio.youtube.com'), 'youtube.com');
  assert.equal(rootDomain('bilibili.com'), 'bilibili.com');
  assert.equal(rootDomain('a.b.com.cn'), 'b.com.cn');
});

test('domainMatches 支持子域与前导点', () => {
  const root = 'bilibili.com';
  assert.equal(domainMatches('.bilibili.com', root), true);
  assert.equal(domainMatches('member.bilibili.com', root), true);
  assert.equal(domainMatches('passport.bilibili.com', root), true);
  assert.equal(domainMatches('.douyin.com', root), false);
  // 不能被同后缀的假域名骗过
  assert.equal(domainMatches('.notbilibili.com', root), false);
  assert.equal(domainMatches('bilibili.com.evil.cn', root), false);
});
