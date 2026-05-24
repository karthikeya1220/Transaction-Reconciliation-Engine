'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');

const REPORTS_DIR = path.resolve(__dirname, '../../reports');

/**
 * CSV column headers for the reconciliation report.
 */
const COLUMNS = [
  'category',
  'reason',
  'matchDetails',
  'user_txId',
  'user_timestamp',
  'user_type',
  'user_asset',
  'user_quantity',
  'exchange_txId',
  'exchange_timestamp',
  'exchange_type',
  'exchange_asset',
  'exchange_quantity',
];

/**
 * Format a Date value for CSV output.
 *
 * @param {Date|null} d
 * @returns {string}
 */
function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toISOString();
  } catch {
    return '';
  }
}

/**
 * Build a single CSV row from a reconciliation result record.
 *
 * @param {string} category   - MATCHED | CONFLICTING | UNMATCHED_USER | UNMATCHED_EXCHANGE
 * @param {object} record     - { userTx, exchangeTx, reason, matchDetails }
 * @returns {object}
 */
function buildRow(category, record) {
  const { userTx, exchangeTx, reason, matchDetails } = record;

  return {
    category,
    reason,
    matchDetails: matchDetails || '',
    // User-side fields
    user_txId: userTx ? (userTx.txId || '') : '',
    user_timestamp: userTx ? fmtDate(userTx.timestamp) : '',
    user_type: userTx ? (userTx.type || '') : '',
    user_asset: userTx ? (userTx.asset || '') : '',
    user_quantity: userTx ? (userTx.quantity !== null ? userTx.quantity : '') : '',
    // Exchange-side fields
    exchange_txId: exchangeTx ? (exchangeTx.txId || '') : '',
    exchange_timestamp: exchangeTx ? fmtDate(exchangeTx.timestamp) : '',
    exchange_type: exchangeTx ? (exchangeTx.type || '') : '',
    exchange_asset: exchangeTx ? (exchangeTx.asset || '') : '',
    exchange_quantity: exchangeTx ? (exchangeTx.quantity !== null ? exchangeTx.quantity : '') : '',
  };
}

/**
 * Generate the reconciliation CSV report and write it to /reports/{runId}.csv.
 *
 * @param {string} runId
 * @param {{ matched: object[], conflicting: object[], unmatchedUser: object[], unmatchedExchange: object[] }} results
 * @returns {string}  Absolute path to the written CSV file
 */
async function generateReport(runId, results) {
  const { matched, conflicting, unmatchedUser, unmatchedExchange } = results;

  const rows = [];

  for (const r of matched) {
    rows.push(buildRow('MATCHED', r));
  }
  for (const r of conflicting) {
    rows.push(buildRow('CONFLICTING', r));
  }
  for (const r of unmatchedUser) {
    rows.push(buildRow('UNMATCHED_USER', r));
  }
  for (const r of unmatchedExchange) {
    rows.push(buildRow('UNMATCHED_EXCHANGE', r));
  }

  // Ensure reports directory exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const csvContent = stringify(rows, {
    header: true,
    columns: COLUMNS,
  });

  const filePath = path.join(REPORTS_DIR, `${runId}.csv`);
  fs.writeFileSync(filePath, csvContent, 'utf-8');

  return filePath;
}

/**
 * Read a previously-generated report CSV and return its rows as an array of objects.
 *
 * @param {string} runId
 * @returns {object[]|null}  null if file does not exist
 */
function readReport(runId) {
  const filePath = path.join(REPORTS_DIR, `${runId}.csv`);
  if (!fs.existsSync(filePath)) return null;

  const { parse } = require('csv-parse/sync');
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parse(raw, { columns: true, skip_empty_lines: true });
}

module.exports = { generateReport, readReport, REPORTS_DIR };
