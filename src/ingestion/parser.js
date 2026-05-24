'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

/**
 * Asset alias map — normalized to standard ticker symbols at parse time.
 * Keys are lowercase for case-insensitive lookup.
 */
const ASSET_ALIASES = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  dogecoin: 'DOGE',
  cardano: 'ADA',
  ripple: 'XRP',
  litecoin: 'LTC',
  polkadot: 'DOT',
  chainlink: 'LINK',
};

/**
 * Known canonical tickers (no alias needed — accepted as-is, uppercased).
 */
const KNOWN_TICKERS = new Set([
  'BTC', 'ETH', 'SOL', 'DOGE', 'ADA', 'XRP', 'LTC', 'DOT', 'LINK', 'USDT', 'USDC', 'BNB',
]);

/**
 * Attempt to parse a raw timestamp string into a JS Date.
 * Tries: ISO 8601, unix milliseconds (numeric), DD/MM/YYYY, MM/DD/YYYY, MM-DD-YYYY.
 *
 * @param {string} raw
 * @returns {Date|null}
 */
function parseTimestamp(raw) {
  if (!raw || String(raw).trim() === '') return null;

  const trimmed = String(raw).trim();

  // Unix ms — pure numeric string
  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed);
    // 10-digit = unix seconds, 13-digit = unix ms
    const ms = trimmed.length === 10 ? n * 1000 : n;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d;
  }

  // ISO 8601 / RFC 2822 / any JS-parseable string
  const isoDate = new Date(trimmed);
  if (!isNaN(isoDate.getTime())) return isoDate;

  // DD/MM/YYYY
  const ddmmyyyy = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }

  // MM-DD-YYYY
  const mmddyyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (mmddyyyy) {
    const [, mm, dd, yyyy] = mmddyyyy;
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Normalize an asset name to a canonical ticker symbol.
 *
 * @param {string} raw
 * @returns {{ asset: string|null, isUnknown: boolean }}
 */
function normalizeAsset(raw) {
  if (!raw || String(raw).trim() === '') {
    return { asset: null, isUnknown: true };
  }

  const trimmed = String(raw).trim();
  const lower = trimmed.toLowerCase();

  // Check alias map first
  if (ASSET_ALIASES[lower]) {
    return { asset: ASSET_ALIASES[lower], isUnknown: false };
  }

  // Check known tickers (case-insensitive)
  const upper = trimmed.toUpperCase();
  if (KNOWN_TICKERS.has(upper)) {
    return { asset: upper, isUnknown: false };
  }

  // Unknown — return uppercased value but flag it
  return { asset: upper, isUnknown: true };
}

/**
 * Parse a CSV file, normalize each row, flag bad data.
 * Bad rows are NOT dropped — they are returned with isValid=false
 * and a populated dataQualityFlags array.
 *
 * @param {string} filePath  - Absolute path to the CSV file
 * @param {string} source    - 'user' | 'exchange'
 * @returns {{ rows: object[], stats: { total: number, valid: number, flagged: number } }}
 */
function parseCSV(filePath, source) {
  const raw = fs.readFileSync(filePath, 'utf-8');

  const records = parse(raw, {
    columns: true,          // use first row as header
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const rows = [];
  let flaggedCount = 0;

  for (const record of records) {
    const flags = [];

    // --- txId ---
    const rawTxId = record.txId || record.tx_id || record.transactionId || record.transaction_id || '';
    const txId = String(rawTxId).trim() || null;
    if (!txId) {
      flags.push({ field: 'txId', issue: 'MISSING_TX_ID', value: String(rawTxId) });
    }

    // --- timestamp ---
    const rawTimestamp = record.timestamp || record.date || record.time || record.datetime || '';
    const timestamp = parseTimestamp(rawTimestamp);
    if (!timestamp) {
      flags.push({ field: 'timestamp', issue: 'UNPARSEABLE_TIMESTAMP', value: String(rawTimestamp) });
    }

    // --- type ---
    const rawType = record.type || record.transaction_type || record.transactionType || '';
    const type = String(rawType).trim().toUpperCase() || null;
    if (!type) {
      flags.push({ field: 'type', issue: 'MISSING_TYPE', value: String(rawType) });
    }

    // --- asset ---
    const rawAsset = record.asset || record.currency || record.coin || '';
    const { asset, isUnknown } = normalizeAsset(rawAsset);
    if (isUnknown) {
      flags.push({ field: 'asset', issue: 'UNKNOWN_ASSET', value: String(rawAsset) });
    }

    // --- quantity ---
    const rawQty = record.quantity || record.amount || record.qty || '';
    const quantity = parseFloat(String(rawQty).replace(/,/g, ''));
    if (isNaN(quantity)) {
      flags.push({ field: 'quantity', issue: 'INVALID_QUANTITY', value: String(rawQty) });
    } else if (quantity < 0) {
      flags.push({ field: 'quantity', issue: 'NEGATIVE_QUANTITY', value: String(rawQty) });
    }

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
      source,
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
