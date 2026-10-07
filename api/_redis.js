// Upstash Redis REST API helper (uses Node.js built-in https - works on Node 14/16/18)
const https = require('https');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisRequest(command) {
  return new Promise((resolve, reject) => {
    if (!REDIS_URL || !REDIS_TOKEN) {
      return reject(new Error('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set'));
    }
    const url  = new URL(REDIS_URL);
    const data = JSON.stringify(command);
    const opts = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + (url.search || ''),
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${REDIS_TOKEN}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, (r) => {
      const _chunks = [];
      r.on('data', chunk => { _chunks.push(Buffer.from(chunk)); });
      r.on('end', () => {
        const body = Buffer.concat(_chunks).toString('utf8');
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Redis parse error: ' + body)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}


// 複数コマンドをまとめて1往復で投げる（履歴退避と本保存を同時に行うため）
function redisPipeline(commands) {
  return new Promise((resolve, reject) => {
    if (!REDIS_URL || !REDIS_TOKEN) {
      return reject(new Error('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set'));
    }
    const url  = new URL(REDIS_URL);
    const data = JSON.stringify(commands);
    const opts = {
      hostname: url.hostname,
      port:     443,
      path:     (url.pathname.replace(/\/$/, '') || '') + '/pipeline' + (url.search || ''),
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${REDIS_TOKEN}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, (r) => {
      const _chunks = [];
      r.on('data', chunk => { _chunks.push(Buffer.from(chunk)); });
      r.on('end', () => {
        const body = Buffer.concat(_chunks).toString('utf8');
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Redis pipeline parse error: ' + body)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Shared CORS headers
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Parse JSON body robustly (Vercel sometimes doesn't auto-parse)
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const _chunks = [];
    req.on('data', chunk => { _chunks.push(Buffer.from(chunk)); });
    req.on('end', () => {
      const raw = Buffer.concat(_chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

module.exports = { redisRequest, redisPipeline, CORS, parseBody };
