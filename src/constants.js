'use strict';

/**
 * Application-wide constants.
 *
 * Using frozen objects prevents accidental mutation and allows IDEs
 * to surface valid values when these are used as function arguments.
 */

/** Valid values for Transaction.source */
const SOURCE = Object.freeze({
  USER: 'user',
  EXCHANGE: 'exchange',
});

/** Valid values for ReconciliationRun.status */
const RUN_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
});

/** Result categories written to the reconciliation report */
const CATEGORY = Object.freeze({
  MATCHED: 'MATCHED',
  CONFLICTING: 'CONFLICTING',
  UNMATCHED_USER: 'UNMATCHED_USER',
  UNMATCHED_EXCHANGE: 'UNMATCHED_EXCHANGE',
});

/** Reason codes attached to each reconciliation result row */
const REASON = Object.freeze({
  EXACT_MATCH: 'EXACT_TX_ID_MATCH',
  EXACT_MATCH_WITH_DISCREPANCY: 'EXACT_TX_ID_MATCH_WITH_DISCREPANCY',
  FUZZY_MATCH: 'FUZZY_PROXIMITY_MATCH',
  NO_MATCH_USER: 'NO_MATCHING_EXCHANGE_TRANSACTION',
  NO_MATCH_EXCHANGE: 'NO_MATCHING_USER_TRANSACTION',
});

/** Data quality flag issue codes */
const DATA_QUALITY_ISSUE = Object.freeze({
  MISSING_TX_ID: 'MISSING_TX_ID',
  UNPARSEABLE_TIMESTAMP: 'UNPARSEABLE_TIMESTAMP',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  NEGATIVE_QUANTITY: 'NEGATIVE_QUANTITY',
  UNKNOWN_ASSET: 'UNKNOWN_ASSET',
  MISSING_TYPE: 'MISSING_TYPE',
});

module.exports = { SOURCE, RUN_STATUS, CATEGORY, REASON, DATA_QUALITY_ISSUE };
