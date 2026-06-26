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
      let body = '';
      r.on('data', chunk => { body += chunk; });
      r.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Redis parse error: ' + body)); }
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
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

module.exports = { redisRequest, CORS, parseBody };
