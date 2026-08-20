'use strict';
/** Applies the schema to whichever backend the environment selects. */
const { migrate, backend } = require('./index');

migrate()
  .then(async () => {
    console.log(`Schema applied to ${backend.kind} (${backend.target})`);
    await backend.close();
  })
  .catch(async (err) => {
    console.error(`Migration failed: ${err.message}`);
    try { await backend.close(); } catch { /* nothing to close */ }
    process.exit(1);
  });
