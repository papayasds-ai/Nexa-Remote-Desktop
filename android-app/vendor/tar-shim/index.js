'use strict';
// Capacitor CLI calls tar.default.extract(). tar v7 has no default export, so expose its functions directly.
const t = require('tar-v7');
module.exports = Object.assign({}, t);
