'use strict';

const Transaction = require('../models/Transaction');

/**
 * Bulk insert parsed transaction rows into MongoDB for a given runId + source.
 * Uses ordered: false so that one bad document does not block the rest.
 *
 * @param {object[]} rows   - Normalized rows from parseCSV()
 * @param {string}   runId  - UUID of the current reconciliation run
 * @param {string}   source - 'user' | 'exchange'
 * @returns {{ inserted: number, errors: any[] }}
 */
async function loadTransactions(rows, runId, source) {
  const docs = rows.map((row) => ({
    ...row,
    runId,
    source,
  }));

  const errors = [];
  let inserted = 0;

  try {
    const result = await Transaction.insertMany(docs, { ordered: false });
    inserted = result.length;
  } catch (err) {
    // insertMany with ordered:false throws a BulkWriteError but still
    // partially inserts successful documents — collect the errors.
    if (err.writeErrors) {
      inserted = docs.length - err.writeErrors.length;
      errors.push(...err.writeErrors.map((e) => e.errmsg || String(e)));
    } else {
      // Unexpected error — rethrow
      throw err;
    }
  }

  return { inserted, errors };
}

module.exports = { loadTransactions };
