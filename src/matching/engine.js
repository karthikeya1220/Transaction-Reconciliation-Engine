'use strict';

const Transaction = require('../models/Transaction');

// ---------------------------------------------------------------------------
// Helper predicates
// ---------------------------------------------------------------------------

/**
 * Returns true if two transaction types represent the same real-world event.
 * TRANSFER_IN (exchange perspective) ↔ TRANSFER_OUT (user perspective).
 *
 * @param {string|null} typeA
 * @param {string|null} typeB
 * @returns {boolean}
 */
function typesMatch(typeA, typeB) {
  if (!typeA || !typeB) return false;
  const a = String(typeA).toUpperCase();
  const b = String(typeB).toUpperCase();
  if (a === b) return true;
  if (
    (a === 'TRANSFER_IN' && b === 'TRANSFER_OUT') ||
    (a === 'TRANSFER_OUT' && b === 'TRANSFER_IN')
  ) {
    return true;
  }
  return false;
}

/**
 * Returns true if two quantities are within the configured tolerance percentage.
 *
 * @param {number|null} qA
 * @param {number|null} qB
 * @param {number}      tolerancePct  e.g. 0.01 = 1%
 * @returns {boolean}
 */
function quantitiesMatch(qA, qB, tolerancePct) {
  if (qA === null || qA === undefined || qB === null || qB === undefined) return false;
  if (qA === 0 && qB === 0) return true;
  const maxVal = Math.max(Math.abs(qA), Math.abs(qB));
  if (maxVal === 0) return true;
  return Math.abs(qA - qB) / maxVal <= tolerancePct;
}

/**
 * Returns true if two timestamps are within the configured tolerance in seconds.
 *
 * @param {Date|null} tsA
 * @param {Date|null} tsB
 * @param {number}    toleranceSecs
 * @returns {boolean}
 */
function timestampsMatch(tsA, tsB, toleranceSecs) {
  if (!tsA || !tsB) return false;
  const deltaMs = Math.abs(new Date(tsA).getTime() - new Date(tsB).getTime());
  return deltaMs / 1000 <= toleranceSecs;
}

/**
 * Returns true if two asset strings are equal (case-insensitive).
 * Assets should already be normalized by the parser.
 *
 * @param {string|null} a
 * @param {string|null} b
 * @returns {boolean}
 */
function assetsMatch(a, b) {
  if (!a || !b) return false;
  return String(a).toUpperCase() === String(b).toUpperCase();
}

/**
 * Compute absolute timestamp delta in milliseconds between two transactions.
 *
 * @param {object} txA
 * @param {object} txB
 * @returns {number}
 */
function tsDeltaMs(txA, txB) {
  return Math.abs(new Date(txA.timestamp).getTime() - new Date(txB.timestamp).getTime());
}

// ---------------------------------------------------------------------------
// Main matching engine
// ---------------------------------------------------------------------------

/**
 * Two-pass matching algorithm:
 *   Pass 1 — Exact txId match
 *   Pass 2 — Fuzzy proximity match (asset + type + timestamp + quantity)
 *
 * @param {string} runId
 * @param {{ timestampToleranceSecs: number, quantityTolerancePct: number }} config
 * @returns {{ matched: object[], conflicting: object[], unmatchedUser: object[], unmatchedExchange: object[] }}
 */
async function matchTransactions(runId, config) {
  const { timestampToleranceSecs, quantityTolerancePct } = config;

  // Load all transactions for this run from MongoDB (lean for performance)
  const userTxs = await Transaction.find({ runId, source: 'user' }).lean();
  const exchangeTxs = await Transaction.find({ runId, source: 'exchange' }).lean();

  const matched = [];
  const conflicting = [];
  const unmatchedUser = [];
  const unmatchedExchange = [];

  // Track matched MongoDB _id strings to avoid double-matching
  const matchedUserIds = new Set();
  const matchedExchangeIds = new Set();

  // Build an index of exchange txs by txId for O(1) Pass 1 lookups
  const exchangeByTxId = new Map();
  for (const ex of exchangeTxs) {
    if (ex.txId) {
      if (!exchangeByTxId.has(ex.txId)) {
        exchangeByTxId.set(ex.txId, []);
      }
      exchangeByTxId.get(ex.txId).push(ex);
    }
  }

  // -------------------------------------------------------------------------
  // PASS 1 — Exact txId match
  // -------------------------------------------------------------------------
  for (const user of userTxs) {
    if (!user.txId) continue; // no txId → skip to Pass 2

    const candidates = exchangeByTxId.get(user.txId) || [];
    // Find first unmatched exchange tx with this txId
    const match = candidates.find((ex) => !matchedExchangeIds.has(String(ex._id)));

    if (!match) continue;

    // Check tolerances to decide matched vs conflicting
    const qOk = quantitiesMatch(user.quantity, match.quantity, quantityTolerancePct);
    const tsOk = timestampsMatch(user.timestamp, match.timestamp, timestampToleranceSecs);

    const mismatchDetails = [];
    if (!qOk) mismatchDetails.push(`quantity mismatch: user=${user.quantity} exchange=${match.quantity}`);
    if (!tsOk) mismatchDetails.push(`timestamp mismatch: delta=${Math.abs(new Date(user.timestamp) - new Date(match.timestamp)) / 1000}s`);

    const record = {
      userTx: user,
      exchangeTx: match,
      reason: qOk && tsOk ? 'EXACT_TX_ID_MATCH' : 'EXACT_TX_ID_MATCH_WITH_DISCREPANCY',
      matchDetails: mismatchDetails.length ? mismatchDetails.join('; ') : 'All fields within tolerance',
    };

    if (qOk && tsOk) {
      matched.push(record);
    } else {
      conflicting.push(record);
    }

    matchedUserIds.add(String(user._id));
    matchedExchangeIds.add(String(match._id));
  }

  // -------------------------------------------------------------------------
  // PASS 2 — Fuzzy proximity match (unmatched transactions only)
  // -------------------------------------------------------------------------
  const remainingUsers = userTxs.filter((u) => !matchedUserIds.has(String(u._id)));
  const remainingExchange = exchangeTxs.filter((ex) => !matchedExchangeIds.has(String(ex._id)));

  for (const user of remainingUsers) {
    // Must have valid timestamp + quantity + asset + type for fuzzy matching
    if (!user.timestamp || user.quantity === null || !user.asset || !user.type) continue;

    // Find all exchange txs that satisfy all fuzzy criteria
    const candidates = remainingExchange.filter((ex) => {
      if (matchedExchangeIds.has(String(ex._id))) return false;
      if (!ex.timestamp || ex.quantity === null || !ex.asset || !ex.type) return false;
      return (
        assetsMatch(user.asset, ex.asset) &&
        typesMatch(user.type, ex.type) &&
        timestampsMatch(user.timestamp, ex.timestamp, timestampToleranceSecs) &&
        quantitiesMatch(user.quantity, ex.quantity, quantityTolerancePct)
      );
    });

    if (candidates.length === 0) continue;

    // Tie-break: pick candidate with smallest timestamp delta
    candidates.sort((a, b) => tsDeltaMs(user, a) - tsDeltaMs(user, b));
    const best = candidates[0];

    matched.push({
      userTx: user,
      exchangeTx: best,
      reason: 'FUZZY_PROXIMITY_MATCH',
      matchDetails: `timestamp delta=${(tsDeltaMs(user, best) / 1000).toFixed(1)}s; quantity delta=${Math.abs(user.quantity - best.quantity).toFixed(8)}`,
    });

    matchedUserIds.add(String(user._id));
    matchedExchangeIds.add(String(best._id));
  }

  // -------------------------------------------------------------------------
  // Collect remaining unmatched
  // -------------------------------------------------------------------------
  for (const user of userTxs) {
    if (!matchedUserIds.has(String(user._id))) {
      unmatchedUser.push({
        userTx: user,
        exchangeTx: null,
        reason: 'NO_MATCHING_EXCHANGE_TRANSACTION',
        matchDetails: '',
      });
    }
  }

  for (const ex of exchangeTxs) {
    if (!matchedExchangeIds.has(String(ex._id))) {
      unmatchedExchange.push({
        userTx: null,
        exchangeTx: ex,
        reason: 'NO_MATCHING_USER_TRANSACTION',
        matchDetails: '',
      });
    }
  }

  return { matched, conflicting, unmatchedUser, unmatchedExchange };
}

module.exports = { matchTransactions, typesMatch, quantitiesMatch, timestampsMatch, assetsMatch };
