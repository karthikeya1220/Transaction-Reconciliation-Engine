'use strict';

/**
 * Minimal structured logger.
 *
 * Writes JSON lines to stdout so output can be piped to log aggregators
 * (e.g. Datadog, CloudWatch) without additional configuration.
 *
 * Format: { level, timestamp, message, ...meta }
 *
 * In development (NODE_ENV !== 'production') the output is pretty-printed
 * so it remains human-readable in the terminal.
 */

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...meta,
  };

  const output = IS_PROD ? JSON.stringify(entry) : JSON.stringify(entry, null, 2);

  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

const logger = {
  /** @param {string} message @param {object} [meta] */
  info: (message, meta) => log('info', message, meta),

  /** @param {string} message @param {object} [meta] */
  warn: (message, meta) => log('warn', message, meta),

  /** @param {string} message @param {object} [meta] */
  error: (message, meta) => log('error', message, meta),
};

module.exports = logger;
