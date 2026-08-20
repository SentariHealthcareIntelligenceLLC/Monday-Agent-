'use strict';
const crypto = require('crypto');
const config = require('../config');

/**
 * HTTP Basic auth for the dashboard and admin API.
 * Public paths (health check, WhatsApp webhook) are skipped.
 */
const PUBLIC = [/^\/health$/, /^\/webhook\//];

module.exports = function basicAuth(req, res, next) {
  if (PUBLIC.some((rx) => rx.test(req.path))) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pass = ''] = Buffer.from(encoded, 'base64').toString().split(':');
    const a = Buffer.from(pass);
    const b = Buffer.from(config.adminPassword);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="QCMS Admin"',
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication required');
};
