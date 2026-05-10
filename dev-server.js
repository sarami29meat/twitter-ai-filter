#!/usr/bin/env node
// dev-server.js — ファイル変更を検知して拡張機能自動リロード + コンソールログ中継

const http = require('http');
const fs   = require('fs');
const path = require('path');

const DIR      = __dirname;
const PORT     = 7654;
const LOG_PORT = 7655;
const TEST_URL = process.argv[2] || 'https://x.com';

let lastModified = Date.now();
const LOG_FILE = path.join(DIR, 'dev-logs.txt');
fs.writeFileSync(LOG_FILE, ''); // 起動時にリセット

// ---- ファイル監視 ----
const WATCH_EXTS = new Set(['.js', '.css', '.html', '.json']);
fs.watch(DIR, { recursive: false }, (event, filename) => {
  if (!filename) return;
  if (!WATCH_EXTS.has(path.extname(filename))) return;
  if (filename === 'dev-server.js') return;
  lastModified = Date.now();
  console.log(`\x1b[33m[dev] 変更検知: ${filename}\x1b[0m`);
});

// ---- リロードシグナルサーバー (background.js がポーリング) ----
http.createServer((req, res) => {
  // POST /reload → 強制リロードトリガー
  if (req.method === 'POST' && req.url === '/reload') {
    lastModified = Date.now();
    fs.writeFileSync(LOG_FILE, ''); // ログもリセット
    console.log('\x1b[33m[dev] 強制リロード発火\x1b[0m');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': 'chrome-extension://*',
  });
  res.end(String(lastModified));
}).listen(PORT, () => {
  console.log(`\x1b[32m[dev] リロードサーバー起動: http://localhost:${PORT}\x1b[0m`);
});

// ---- コンソールログ受信サーバー (content.js / background.js が POST) ----
const logServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(204); res.end(); return; }
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    res.writeHead(204);
    res.end();
    try {
      const { level = 'log', msg } = JSON.parse(body);
      const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
      const line = `[ext] ${msg}`;
      console.log(`${color}${line}\x1b[0m`);
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (_) {}
  });
});
logServer.listen(LOG_PORT, () => {
  console.log(`\x1b[32m[dev] ログサーバー起動: http://localhost:${LOG_PORT}\x1b[0m`);
});

// ---- Chrome を開いてテストURLに誘導 ----
const { exec } = require('child_process');
setTimeout(() => {
  exec(`open -a "Google Chrome" "${TEST_URL}"`);
  console.log(`\x1b[32m[dev] Chrome開く: ${TEST_URL}\x1b[0m`);
}, 500);

console.log('\x1b[90m[dev] Ctrl+C で終了\x1b[0m');
