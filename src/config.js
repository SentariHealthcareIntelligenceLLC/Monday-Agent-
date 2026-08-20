'use strict';
require('./lib/env').loadEnv();

const bool = (v, d = false) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  tz: process.env.TZ || 'America/Los_Angeles',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me',
  databaseFile: process.env.DATABASE_FILE || './data/qcms.sqlite',
  dryRun: bool(process.env.DRY_RUN, true),
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    token: process.env.WHATSAPP_TOKEN || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'qcms-verify-token-change-me',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    templates: {
      reminder: process.env.TEMPLATE_TASK_REMINDER || 'qcms_task_reminder',
      escalation: process.env.TEMPLATE_ESCALATION || 'qcms_escalation',
      lang: process.env.TEMPLATE_LANG || 'en_US',
    },
  },
  cron: {
    daily: process.env.DAILY_REMINDER_CRON || '0 8 * * *',
    midday: process.env.MIDDAY_NUDGE_CRON || '0 13 * * *',
    escalation: process.env.ESCALATION_CRON || '0 17 * * *',
  },
};

module.exports = config;
