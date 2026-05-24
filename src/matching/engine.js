'use strict';

const Transaction = require('../models/Transaction');
const { REASON } = require('../constants');

// ---------------------------------------------------------------------------
// Helper predicates
// ---------------------------------------------------------------------------

/**
 * Returns true if two transaction types represent the same real-world event.
 *
 * TRANSFER_IN (exchange perspective) and TRANSFER_OUT (user perspective)
 * are treated as equivalent because a single crypto transfer appears as
 * outbound on one side and inbound on the other.
 *
 * @param {string | null} typeA
 * @param {string | null} typeB
 * @returns {boolean}
 */
function typesMatch(typeA, typeB) {
  if (!typeA || !typeB) return false;
  const a = String(typeA).toUpperCase();
  const b = String(typeB).toUpperCase();
  if (a === b) return true;
  return (
    (a === 'TRANSFER_IN' && b === 'TRANSFER_OUT') ||
    (a === 'TRANSFER_OUT' && b === 'TRANSFER_IN')
  );
}

/**
 * Returns true if two quantities are within the configured tolerance.
 *
 * Uses relative difference: |a - b| / max(|a|, |b|) <= tolerancePct.
 * Special case: both zero is always true.
 *
 * @param {number | null} qA
 * @param {number | null} qB
 * @param {number}        tolerancePct  e.g. 0.01 for 1%
 * @returns {boolean}
 */
function quantitiesMatch(qA, qB, tolerancePct) {
  if (qA == null || qB == null) return false;
  if (qA === 0 && qB === 0) return true;
  const denominator = Math.max(Math.abs(qA), Math.abs(qB));
  if (denominator === 0) return true;
  return Math.abs(qA - qB) / denominator <= tolerancePct;
}

/**
 * Returns true if two timestamps differ by at most toleranceSecs seconds.
 *
 * @param {Date | null} tsA
 * @param {Date | null} tsB
 * @param {number}      toleranceSecs
 * @returns {boolean}
 */
function timestampsMatch(tsA, tsB, toleranceSecs) {
  if (!tsA || !tsB) return false;
  const deltaMs = Math.abs(new Date(tsA).getTime() - new Date(tsB).getTime());
  return deltaMs / 1000 <= toleranceSecs;
}

/**
 * Returns true if two asset strings are equal (case-insensitive).
 * Assets are already normalised to tickers by the parser.
 *
 * @param {string | null} a
 * @param {string | null} b
 * @returns {boolean}
 */
function assetsMatch(a, b) {
  if (!a || !b) return false;
  return String(a).toUpperCase() === String(b).toUpperCase();
}

/**
 * Returns the absolute timestamp delta in milliseconds between two transactions.
 *
 * @param {{ timestamp: Date }} txA
 * @param {{ timestamp: Date }} txB
 * @returns {number}
 */
function tsDeltaMs(txA, txB) {
  return Math.abs(new Date(txA.timestamp).getTime() - new Date(txB.timestamp).getTime());
}

// ---------------------------------------------------------------------------
// Pass 1 — Exact txId match
// ---------------------------------------------------------------------------

/**
 * @param {object[]} userTxs
 * @param {Map<string, object[]>} exchangeByTxId
 * @param {Set<string>} matchedUserIds
 * @param {Set<string>} matchedExchangeIds
 * @param {{ timestampToleranceSecs: number, quantityTolerancePct: number }} config
 * @returns {{ matched: object[], conflicting: object[] }}
 */
function runPass1(userTxs, exchangeByTxId, matchedUserIds, matchedExchangeIds, config) {
  const matched = [];
  const conflicting = [];
  const { timestampToleranceSecs, quantityTolerancePct } = config;

  for (const user of userTxs) {
    if (!user.txId) continue;

    const candidates = exchangeByTxId.get(user.txId) ?? [];
    const counterpart = candidates.find((ex) => !matchedExchangeIds.has(String(ex._id)));
    if (!counterpart) continue;

    const qOk = quantitiesMatch(user.quantity, counterpart.quantity, quantityTolerancePct);
    const tsOk = timestampsMatch(user.timestamp, counterpart.timestamp, timestampToleranceSecs);
    const discrepancies = [];

    if (!qOk) {
      discrepancies.push(
        `quantity mismatch: user=${user.quantity} exchange=${counterpart.quantity}`
      );
    }
    if (!tsOk) {
      const deltaS = (Math.abs(new Date(user.timestamp) - new Date(counterpart.timestamp)) / 1000).toFixed(1);
      discrepancies.push(`timestamp mismatch: delta=${deltaS}s`);
    }

    const record = {
      userTx: user,
      exchangeTx: counterpart,
      reason: qOk && tsOk ? REASON.EXACT_MATCH : REASON.EXACT_MATCH_WITH_DISCREPANCY,
      matchDetails: discrepancies.length > 0 ? discrepancies.join('; ') : 'All fields within tolerance',
    };

    if (qOk && tsOk) {
      matched.push(record);
    } else {
      conflicting.push(record);
    }

    matchedUserIds.add(String(user._id));
    matchedExchangeIds.add(String(counterpart._id));
  }

  return { matched, conflicting };
}

// ---------------------------------------------------------------------------
// Pass 2 — Fuzzy proximity match
// ---------------------------------------------------------------------------

/**
 * @param {object[]} userTxs
 * @param {object[]} exchangeTxs
 * @param {Set<string>} matchedUserIds
 * @param {Set<string>} matchedExchangeIds
 * @param {{ timestampToleranceSecs: number, quantityTolerancePct: number }} config
 * @returns {object[]} matched records
 */
function runPass2(userTxs, exchangeTxs, matchedUserIds, matchedExchangeIds, config) {
  const matched = [];
  const { timestampToleranceSecs, quantityTolerancePct } = config;

  const remainingUsers = userTxs.filter((u) => !matchedUserIds.has(String(u._id)));
  const remainingExchange = exchangeTxs.filter((ex) => !matchedExchangeIds.has(String(ex._id)));

  for (const user of remainingUsers) {
    // A row must have all four fields to participate in fuzzy matching
    if (!user.timestamp || user.quantity == null || !user.asset || !user.type) continue;

    const candidates = remainingExchange.filter((ex) => {
      if (matchedExchangeIds.has(String(ex._id))) return false;
      if (!ex.timestamp || ex.quantity == null || !ex.asset || !ex.type) return false;
      return (
        assetsMatch(user.asset, ex.asset) &&
        typesMatch(user.type, ex.type) &&
        timestampsMatch(user.timestamp, ex.timestamp, timestampToleranceSecs) &&
        quantitiesMatch(user.quantity, ex.quantity, quantityTolerancePct)
      );
    });

    if (candidates.length === 0) continue;

    // Tie-break by smallest timestamp delta — most temporally proximate is the safest choice
    candidates.sort((a, b) => tsDeltaMs(user, a) - tsDeltaMs(user, b));
    const best = candidates[0];

    matched.push({
      userTx: user,
      exchangeTx: best,
      reason: REASON.FUZZY_MATCH,
      matchDetails: [
        `timestamp delta=${(tsDeltaMs(user, best) / 1000).toFixed(1)}s`,
        `quantity delta=${Math.abs(user.quantity - best.quantity).toFixed(8)}`,
      ].join('; '),
    });

    matchedUserIds.add(String(user._id));
    matchedExchangeIds.add(String(best._id));
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

/**
 * Run the two-pass reconciliation algorithm against transactions stored in
 * MongoDB for the given runId.
 *
 * @param {string} runId
 * @param {{ timestampToleranceSecs: number, quantityTolerancePct: number }} config
 * @returns {Promise<{
 *   matched: object[],
 *   conflicting: object[],
 *   unmatchedUser: object[],
 *   unmatchedExchange: object[]
 * }>}
 */
async function matchTransactions(runId, config) {
  const [userTxs, exchangeTxs] = await Promise.all([
    Transaction.find({ runId, source: 'user' }).lean(),
    Transaction.find({ runId, source: 'exchange' }).lean(),
  ]);

  const matchedUserIds = new Set();
  const matchedExchangeIds = new Set();

  // Build an O(1) lookup index for Pass 1
  const exchangeByTxId = new Map();
  for (const ex of exchangeTxs) {
    if (ex.txId) {
      if (!exchangeByTxId.has(ex.txId)) exchangeByTxId.set(ex.txId, []);
      exchangeByTxId.get(ex.txId).push(ex);
    }
  }

  const { matched: p1Matched, conflicting } = runPass1(
    userTxs, exchangeByTxId, matchedUserIds, matchedExchangeIds, config
  );

  const p2Matched = runPass2(
    userTxs, exchangeTxs, matchedUserIds, matchedExchangeIds, config
  );

  const matched = [...p1Matched, ...p2Matched];

  const unmatchedUser = userTxs
    .filter((u) => !matchedUserIds.has(String(u._id)))
    .map((userTx) => ({ userTx, exchangeTx: null, reason: REASON.NO_MATCH_USER, matchDetails: '' }));

  const unmatchedExchange = exchangeTxs
    .filter((ex) => !matchedExchangeIds.has(String(ex._id)))
    .map((exchangeTx) => ({ userTx: null, exchangeTx, reason: REASON.NO_MATCH_EXCHANGE, matchDetails: '' }));

  return { matched, conflicting, unmatchedUser, unmatchedExchange };
}

module.exports = { matchTransactions, typesMatch, quantitiesMatch, timestampsMatch, assetsMatch };
