'use strict';

/**
 * 自测用的「模拟创作中心」：一个本地网页，模拟真实平台的上传/标题/正文/话题/发布按钮，
 * 用于验证引擎的注入、填写、点击、上传状态判断是否正常。仅用于测试，不参与打包运行。
 *
 * 支持 ?late=<毫秒> 模拟「页面监听尚未挂上就收到文件」的场景，用于验证重试注入。
 */

const http = require('node:http');

function pageHtml(lateMs) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>模拟创作中心</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; padding: 30px; background: #f6f7f9; }
  .avatar { display: inline-block; padding: 6px 10px; background: #e8f0ff; border-radius: 8px; margin-bottom: 16px; }
  #file { display: none; margin: 10px 0; }
  #title { width: 420px; padding: 8px; }
  #content { width: 520px; min-height: 90px; background: #fff; border: 1px solid #ccc; padding: 8px; margin-top: 10px; }
  .video-preview { margin-top: 12px; padding: 8px 10px; background: #d9f7e3; display: inline-block; border-radius: 6px; }
  #pending { color: #d97706; }
  button { margin-top: 12px; padding: 8px 16px; }
</style>
</head>
<body>
  <div class="avatar">测试用户</div>
  <div>
    <button id="open">上传视频</button>
    <input type="file" id="file" accept="video/*">
  </div>
  <div id="pending" style="display:none">上传中...</div>
  <div style="margin-top:16px">
    <input id="title" placeholder="请输入标题" />
  </div>
  <div id="content" contenteditable="true" data-placeholder="请输入简介"></div>
  <div><input type="file" id="cover" accept="image/*"></div>
  <button id="publish">发布</button>
  <script>
    const LATE = ${Number(lateMs) || 0};
    const state = { title: '', content: '', fileName: '', fileSize: 0 };
    const send = () => fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) }).catch(() => {});
    function onFileChange(event) {
      const file = event.target.files && event.target.files[0];
      state.fileName = file ? file.name : '';
      state.fileSize = file ? file.size : 0;
      send();
      const pending = document.getElementById('pending');
      pending.style.display = 'block';
      setTimeout(() => {
        pending.style.display = 'none';
        const preview = document.createElement('div');
        preview.className = 'video-preview';
        preview.textContent = '视频预览已生成';
        document.body.appendChild(preview);
      }, 900);
    }
    function bindFile() {
      document.getElementById('file').addEventListener('change', onFileChange);
    }
    if (LATE > 0) setTimeout(bindFile, LATE); else bindFile();
    document.getElementById('title').addEventListener('input', (event) => {
      state.title = event.target.value;
      send();
    });
    document.getElementById('content').addEventListener('input', (event) => {
      state.content = event.target.innerText || '';
      send();
    });
    document.getElementById('open').addEventListener('click', () => {
      document.getElementById('file').style.display = 'block';
    });
    document.getElementById('publish').addEventListener('click', () => {
      document.getElementById('publish').textContent = '已发布(模拟)';
    });
  </script>
</body>
</html>`;
}

const PAGE = pageHtml(0);

function createMockServer(port = 0) {
  let state = { title: '', content: '', fileName: '', fileSize: 0, clicks: 0 };

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          state = { ...state, ...JSON.parse(body || '{}') };
        } catch (err) {
          /* ignore */
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    let late = 0;
    try {
      late = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('late')) || 0;
    } catch (err) {
      late = 0;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml(late));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;
      resolve({
        port: address.port,
        url: `${base}/`,
        getState: () => ({ ...state }),
        reset: () => {
          state = { title: '', content: '', fileName: '', fileSize: 0, clicks: 0 };
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { createMockServer, PAGE, pageHtml };
