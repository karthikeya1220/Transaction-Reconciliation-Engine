'use strict';

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { DATA_QUALITY_ISSUE } = require('../constants');

/**
 * Asset alias map — full names normalised to standard ticker symbols at parse time.
 * Keys are lowercase for case-insensitive lookup.
 *
 * @type {Record<string, string>}
 */
const ASSET_ALIASES = Object.freeze({
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  dogecoin: 'DOGE',
  cardano: 'ADA',
  ripple: 'XRP',
  litecoin: 'LTC',
  polkadot: 'DOT',
  chainlink: 'LINK',
  avalanche: 'AVAX',
  polygon: 'MATIC',
  shiba: 'SHIB',
});

/**
 * Known canonical tickers (accepted as-is after uppercasing, no alias needed).
 *
 * @type {Set<string>}
 */
const KNOWN_TICKERS = new Set([
  'BTC', 'ETH', 'SOL', 'DOGE', 'ADA', 'XRP', 'LTC', 'DOT', 'LINK',
  'USDT', 'USDC', 'BNB', 'AVAX', 'MATIC', 'SHIB',
]);

// ---------------------------------------------------------------------------
// Field extractors
//
// CSV column names vary between data providers. Each extractor checks several
// plausible header names in priority order and returns the first non-empty
// value found.
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, string>} record
 * @returns {string}
 */
const extractTxId = (record) =>
  record.txId ?? record.tx_id ?? record.transactionId ?? record.transaction_id ?? '';

/**
 * @param {Record<string, string>} record
 * @returns {string}
 */
const extractTimestamp = (record) =>
  record.timestamp ?? record.date ?? record.time ?? record.datetime ?? '';

/**
 * @param {Record<string, string>} record
 * @returns {string}
 */
const extractType = (record) =>
  record.type ?? record.transaction_type ?? record.transactionType ?? '';

/**
 * @param {Record<string, string>} record
 * @returns {string}
 */
const extractAsset = (record) =>
  record.asset ?? record.currency ?? record.coin ?? '';

/**
 * @param {Record<string, string>} record
 * @returns {string}
 */
const extractQuantity = (record) =>
  record.quantity ?? record.amount ?? record.qty ?? '';

// ---------------------------------------------------------------------------
// Parsers and normalisers
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a raw value into a JS Date.
 * Tries formats in order: unix ms, unix seconds, ISO/JS-parseable, DD/MM/YYYY, MM-DD-YYYY.
 *
 * @param {string} raw
 * @returns {Date | null}
 */
function parseTimestamp(raw) {
  if (!raw || String(raw).trim() === '') return null;

  const trimmed = String(raw).trim();

  // Unix timestamps — pure numeric strings
  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed);
    const ms = trimmed.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d;
  }

  // ISO 8601 / RFC 2822 and any string JS Date can parse
  const direct = new Date(trimmed);
  if (!isNaN(direct.getTime())) return direct;

  // DD/MM/YYYY  (e.g. 15/01/2024)
  const ddmmyyyy = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }

  // MM-DD-YYYY  (e.g. 01-15-2024)
  const mmddyyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (mmddyyyy) {
    const [, mm, dd, yyyy] = mmddyyyy;
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Normalise an asset name to its canonical ticker symbol.
 *
 * @param {string} raw
 * @returns {{ asset: string | null, isUnknown: boolean }}
 */
function normaliseAsset(raw) {
  if (!raw || String(raw).trim() === '') {
    return { asset: null, isUnknown: true };
  }

  const trimmed = String(raw).trim();

  // Full-name alias (e.g. "Bitcoin" → "BTC")
  const alias = ASSET_ALIASES[trimmed.toLowerCase()];
  if (alias) return { asset: alias, isUnknown: false };

  // Already a known ticker
  const upper = trimmed.toUpperCase();
  if (KNOWN_TICKERS.has(upper)) return { asset: upper, isUnknown: false };

  // Unknown — store uppercased and flag
  return { asset: upper, isUnknown: true };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a CSV file, normalise every field, and flag data quality issues.
 *
 * Bad rows are NEVER dropped — they are returned with `isValid: false`
 * and a populated `dataQualityFlags` array. This ensures every input row
 * is accounted for in the final reconciliation report.
 *
 * @param {string} filePath  Absolute path to the CSV file
 * @param {string} source    'user' | 'exchange'
 * @returns {{
 *   rows: import('../models/Transaction')[],
 *   stats: { total: number, valid: number, flagged: number }
 * }}
 */
function parseCSV(filePath, source) {
  const rawCsv = fs.readFileSync(filePath, 'utf-8');

  const records = parse(rawCsv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const rows = [];
  let flaggedCount = 0;

  for (const record of records) {
    const flags = [];

    // --- txId ---------------------------------------------------------------
    const rawTxId = extractTxId(record);
    const txId = String(rawTxId).trim() || null;
    if (!txId) {
      flags.push({ field: 'txId', issue: DATA_QUALITY_ISSUE.MISSING_TX_ID, value: rawTxId });
    }

    // --- timestamp ----------------------------------------------------------
    const rawTimestamp = extractTimestamp(record);
    const timestamp = parseTimestamp(rawTimestamp);
    if (!timestamp) {
      flags.push({
        field: 'timestamp',
        issue: DATA_QUALITY_ISSUE.UNPARSEABLE_TIMESTAMP,
        value: String(rawTimestamp),
      });
    }

    // --- type ---------------------------------------------------------------
    const rawType = extractType(record);
    const type = String(rawType).trim().toUpperCase() || null;
    if (!type) {
      flags.push({ field: 'type', issue: DATA_QUALITY_ISSUE.MISSING_TYPE, value: String(rawType) });
    }

    // --- asset --------------------------------------------------------------
    const rawAsset = extractAsset(record);
    const { asset, isUnknown } = normaliseAsset(rawAsset);
    if (isUnknown) {
      flags.push({ field: 'asset', issue: DATA_QUALITY_ISSUE.UNKNOWN_ASSET, value: String(rawAsset) });
    }

    // --- quantity -----------------------------------------------------------
    const rawQty = extractQuantity(record);
    const quantity = parseFloat(String(rawQty).replace(/,/g, ''));
    if (isNaN(quantity)) {
      flags.push({ field: 'quantity', issue: DATA_QUALITY_ISSUE.INVALID_QUANTITY, value: String(rawQty) });
    } else if (quantity < 0) {
      flags.push({ field: 'quantity', issue: DATA_QUALITY_ISSUE.NEGATIVE_QUANTITY, value: String(rawQty) });
    }

    // --- assemble -----------------------------------------------------------
    const isValid = flags.length === 0;
    if (!isValid) flaggedCount++;

    rows.push({
      txId,
      timestamp,
      type,
      asset,
      quantity: isNaN(quantity) ? null : quantity,
      rawRow: { ...record },
      dataQualityFlags: flags,
      isValid,
    });
  }

  return {
    rows,
    stats: {
      total: rows.length,
      valid: rows.length - flaggedCount,
      flagged: flaggedCount,
    },
  };
}

module.exports = { parseCSV, ASSET_ALIASES, KNOWN_TICKERS };
