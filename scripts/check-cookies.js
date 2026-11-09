'use strict';

const { app, session } = require('electron');
const path = require('node:path');

const profile = process.env.MP_PROFILE || '';
if (profile) app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setName('自媒体发布助手');

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:platforms');
  const cookies = await ses.cookies.get({ domain: 'channels.weixin.qq.com' });
  console.log('COOKIE_COUNT', cookies.length);
  for (const c of cookies) console.log(c.name, c.domain, c.path, c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session');
  app.exit(0);
});
