'use strict';

const mongoose = require('mongoose');
const { SOURCE } = require('../constants');

/**
 * DataQualityFlag sub-document schema.
 *
 * Each flag describes one specific problem found in a raw CSV field.
 * Flags are stored as a subdocument array rather than a flat object so
 * multiple issues on the same row can be recorded independently.
 */
const dataQualityFlagSchema = new mongoose.Schema(
  {
    field: {
      type: String,
      required: true,
    },
    issue: {
      type: String,
      required: true,
    },
    /** The original raw string value that triggered the flag. */
    value: {
      type: String,
      default: null,
    },
  },
  { _id: false } // flags are value objects — no independent identity
);

/**
 * Transaction Schema
 *
 * One document per CSV row, from either the user or exchange dataset.
 *
 * Design decisions:
 *  - `txId` is sparse-indexed: most docs have one, some legitimately don't.
 *    A sparse index only indexes documents where the field exists, which
 *    avoids a large index full of nulls and keeps Pass 1 lookups fast.
 *  - `rawRow` is excluded from normal projections (select: false).
 *    It is stored purely for auditability; no query logic reads it.
 *  - `dataQualityFlags` defaults to [] so the field is always present,
 *    making it safe to call `.length` on without null-checking.
 *  - `isValid` is a denormalised boolean derived from dataQualityFlags.length.
 *    Stored explicitly so queries like "count invalid rows per run" are
 *    fast without requiring an aggregation pipeline.
 *  - Compound index on { runId, source } covers the two most common
 *    query patterns: "all user txs for run X" and "all exchange txs for run X".
 */
const transactionSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
    },

    source: {
      type: String,
      enum: Object.values(SOURCE),
      required: true,
    },

    /** Normalised transaction ID. Null when absent in source data. */
    txId: {
      type: String,
      default: null,
    },

    /** Parsed timestamp. Null when the raw value could not be parsed. */
    timestamp: {
      type: Date,
      default: null,
    },

    /** Normalised to uppercase (e.g. 'BUY', 'SELL', 'TRANSFER_OUT'). */
    type: {
      type: String,
      default: null,
    },

    /** Normalised to canonical ticker symbol (e.g. 'BTC', 'ETH'). */
    asset: {
      type: String,
      default: null,
    },

    quantity: {
      type: Number,
      default: null,
    },

    /**
     * Verbatim original CSV row preserved for auditability.
     * Excluded from all queries by default — only fetched when explicitly
     * projected via `.select('+rawRow')`.
     */
    rawRow: {
      type: mongoose.Schema.Types.Mixed,
      select: false,
    },

    /** Array of field-level data quality issues. Empty array = clean row. */
    dataQualityFlags: {
      type: [dataQualityFlagSchema],
      default: [],
    },

    /**
     * Denormalised validity flag.
     * false iff dataQualityFlags.length > 0.
     * Stored explicitly to enable fast count queries without aggregation.
     */
    isValid: {
      type: Boolean,
      required: true,
      default: true,
    },
  },
  {
    timestamps: { createdAt: 'insertedAt', updatedAt: false },
    versionKey: false,
  }
);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/**
 * Primary query index: "all user|exchange transactions for this run".
 * Covers both Pass 1 and Pass 2 of the matching engine.
 */
transactionSchema.index({ runId: 1, source: 1 });

/**
 * Sparse index on txId for O(1) Pass 1 exact-match lookups.
 * Sparse means documents where txId is null are NOT indexed,
 * keeping the index small and fast.
 */
transactionSchema.index({ txId: 1 }, { sparse: true });

/**
 * Partial index for fast "flagged rows per run" queries.
 * Only indexes documents where isValid is false.
 */
transactionSchema.index(
  { runId: 1, isValid: 1 },
  { partialFilterExpression: { isValid: false } }
);

module.exports = mongoose.model('Transaction', transactionSchema);
