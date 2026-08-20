'use strict';
/**
 * Vercel serverless entrypoint. vercel.json rewrites every path here, so the
 * router in src/lib/http.js does the routing exactly as it does under Docker.
 *
 * The handler is built once per lambda instance and reused across warm
 * invocations, along with the pooled Postgres connection.
 */
const { buildApp } = require('../src/app');

const app = buildApp();

module.exports = (req, res) => app.handle(req, res);
