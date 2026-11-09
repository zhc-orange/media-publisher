'use strict';

/**
 * 本地媒体预览协议 app-media://
 * 只允许读取 media-store 里登记过的视频/封面，并支持 Range 请求（视频拖动进度条需要）。
 * 使用流式响应，单次分片上限 8MB，避免大视频把主进程内存打爆。
 */

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { protocol } = require('electron');
const mediaStore = require('./media-store');

const MAX_CHUNK = 8 * 1024 * 1024;

const MEDIA_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const PRIVILEGES = [{ scheme: 'app-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }];

function parseRange(range, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range || '').trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start;
  let end;
  if (!hasStart) {
    // bytes=-500：最后 500 字节
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0) start = 0;
  if (end >= total) end = total - 1;
  if (start > end || start >= total) return { invalid: true };
  return { start, end };
}

function streamResponse(filePath, start, end, status, mime, total) {
  const length = end - start + 1;
  const nodeStream = fs.createReadStream(filePath, { start, end });
  const body = Readable.toWeb(nodeStream);
  const headers = {
    'Content-Type': mime,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  return new Response(body, { status, headers });
}

function registerMediaProtocol() {
  protocol.handle('app-media', async (request) => {
    try {
      const url = new URL(request.url);
      const kind = url.hostname === 'video' ? 'video' : url.hostname === 'cover' ? 'cover' : '';
      if (!kind) return new Response('not found', { status: 404 });
      const filePath = mediaStore.get(kind);
      if (!filePath || !fs.existsSync(filePath)) return new Response('not found', { status: 404 });
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return new Response('not found', { status: 404 });
      const total = stat.size;
      const mime = MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      if (total === 0) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { 'Content-Type': mime, 'Content-Length': '0', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
        });
      }

      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Type': mime, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
        });
      }

      const range = request.headers.get('range');
      if (range) {
        const parsed = parseRange(range, total);
        if (!parsed) {
          return new Response('invalid range', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
        }
        if (parsed.invalid) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
        }
        // 播放器常见 bytes=0- 请求：只返回前 8MB，后续由播放器继续请求，避免整段读入内存
        const end = Math.min(parsed.end, parsed.start + MAX_CHUNK - 1);
        return streamResponse(filePath, parsed.start, end, 206, mime, total);
      }

      return streamResponse(filePath, 0, Math.max(0, total - 1), 200, mime, total);
    } catch (err) {
      return new Response(`error: ${err.message}`, { status: 500 });
    }
  });
}

module.exports = { registerMediaProtocol, PRIVILEGES, MEDIA_MIME };
