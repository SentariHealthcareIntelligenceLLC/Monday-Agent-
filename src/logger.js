'use strict';
/** Tiny structured logger — no dependencies. */
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const level = LEVELS[process.env.LOG_LEVEL] || (config.env === 'test' ? LEVELS.silent : LEVELS.info);

function emit(name, obj, msg) {
  if (LEVELS[name] < level) return;
  if (typeof obj === 'string') { msg = obj; obj = {}; }
  const line = { t: new Date().toISOString(), level: name, msg, ...obj };
  const out = config.env === 'development'
    ? `${line.t} ${name.toUpperCase().padEnd(5)} ${msg || ''} ${Object.keys(obj || {}).length ? JSON.stringify(obj) : ''}`
    : JSON.stringify(line);
  (name === 'error' || name === 'warn' ? console.error : console.log)(out);
}

module.exports = {
  debug: (o, m) => emit('debug', o, m),
  info: (o, m) => emit('info', o, m),
  warn: (o, m) => emit('warn', o, m),
  error: (o, m) => emit('error', o, m),
};
