'use strict';
/** A very small HTTP router on node:http — no dependencies. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function createApp() {
  const routes = [];
  const middlewares = [];

  const compile = (pattern) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:([A-Za-z_]\w*)/g, (_, k) => {
      keys.push(k); return '([^/]+)';
    }).replace(/\/$/, '/?') + '$');
    return { rx, keys };
  };

  const add = (method, pattern, handler) =>
    routes.push({ method, handler, ...compile(pattern) });

  const app = {
    use: (fn) => middlewares.push(fn),
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    staticDir: null,
    handle,
    listen: (port, cb) => http.createServer(handle).listen(port, cb),
  };

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function decorate(res) {
    res.json = (obj, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    res.text = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(body));
    };
    res.status = (code) => { res.statusCode = code; return res; };
    return res;
  }

  function serveStatic(req, res, url) {
    if (!app.staticDir) return false;
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(app.staticDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(app.staticDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  async function handle(req, res) {
    decorate(res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    req.query = Object.fromEntries(url.searchParams);
    req.path = url.pathname;

    try {
      const raw = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
      req.rawBody = raw;
      req.body = {};
      if (raw.length && (req.headers['content-type'] || '').includes('json')) {
        try { req.body = JSON.parse(raw.toString('utf8')); } catch { req.body = {}; }
      }

      for (const mw of middlewares) {
        let passed = false;
        await mw(req, res, () => { passed = true; });
        if (!passed) return;
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.rx.exec(url.pathname);
        if (!m) continue;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await r.handler(req, res);
      }

      if (req.method === 'GET' && serveStatic(req, res, url)) return;
      res.json({ error: 'not found' }, 404);
    } catch (err) {
      if (!res.headersSent) res.json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }

  return app;
}

module.exports = { createApp };
