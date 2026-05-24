'use strict';

const Transaction = require('../models/Transaction');

/**
 * Bulk-insert parsed transaction rows into MongoDB for a given run.
 *
 * Uses `ordered: false` so that a single malformed document does not
 * prevent the rest of the batch from being inserted. Write errors are
 * collected and returned rather than thrown, keeping the pipeline running.
 *
 * @param {object[]} rows    Normalised rows produced by parseCSV()
 * @param {string}   runId   UUID of the current reconciliation run
 * @param {string}   source  'user' | 'exchange'
 * @returns {Promise<{ inserted: number, errors: string[] }>}
 */
async function loadTransactions(rows, runId, source) {
  if (rows.length === 0) {
    return { inserted: 0, errors: [] };
  }

  const docs = rows.map((row) => ({ ...row, runId, source }));
  const errors = [];
  let inserted = 0;

  try {
    const result = await Transaction.insertMany(docs, { ordered: false });
    inserted = result.length;
  } catch (err) {
    if (err.name === 'MongoBulkWriteError' && err.result) {
      // Partial success — insertMany with ordered:false still inserts valid docs
      inserted = err.result.nInserted;
      for (const writeError of (err.writeErrors ?? [])) {
        errors.push(writeError.errmsg ?? String(writeError));
      }
    } else {
      throw err;
    }
  }

  return { inserted, errors };
}

module.exports = { loadTransactions };
