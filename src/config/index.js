'use strict';

require('dotenv').config();

/**
 * Central config object — reads env vars with documented defaults.
 * Throws on missing required vars so startup fails fast and loud.
 */

if (!process.env.MONGODB_URI) {
  throw new Error('Missing required env var: MONGODB_URI');
}

const config = Object.freeze({
  mongodbUri: process.env.MONGODB_URI,
  port: parseInt(process.env.PORT, 10) || 3000,
  timestampToleranceSecs: parseInt(process.env.TIMESTAMP_TOLERANCE_SECONDS, 10) || 300,
  quantityTolerancePct: parseFloat(process.env.QUANTITY_TOLERANCE_PCT) || 0.01,
});

module.exports = config;
