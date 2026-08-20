'use strict';
const { migrate, file } = require('./index');
migrate();
console.log(`Schema applied to ${file}`);
