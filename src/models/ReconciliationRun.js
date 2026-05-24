'use strict';

const mongoose = require('mongoose');
const { RUN_STATUS } = require('../constants');

/**
 * RunConfig sub-document schema.
 *
 * Captures the exact tolerance values used for this run so results
 * can always be re-interpreted in their original context, even if
 * the global defaults change later.
 */
const runConfigSchema = new mongoose.Schema(
  {
    timestampToleranceSecs: {
      type: Number,
      required: true,
      min: 0,
    },
    quantityTolerancePct: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
  },
  { _id: false }
);

/**
 * RunSummary sub-document schema.
 *
 * Aggregate counts written once when the run completes.
 * Stored here (not computed from the Transaction collection) so that
 * GET /summary is a single indexed document read, not an aggregation.
 */
const runSummarySchema = new mongoose.Schema(
  {
    matched: { type: Number, default: 0, min: 0 },
    conflicting: { type: Number, default: 0, min: 0 },
    unmatchedUser: { type: Number, default: 0, min: 0 },
    unmatchedExchange: { type: Number, default: 0, min: 0 },
    /** Total rows across both CSVs that had at least one data quality flag. */
    totalFlagged: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/**
 * ReconciliationRun Schema
 *
 * One document per POST /reconcile call. Tracks the full lifecycle of a
 * reconciliation job: pending → running → done | failed.
 *
 * Design decisions:
 *  - `runId` is the external identifier (UUID v4). MongoDB's _id is kept
 *    as an internal implementation detail and never exposed via the API.
 *  - `config` and `summary` are sub-documents (not nested plain objects)
 *    so Mongoose applies schema validation to their fields.
 *  - `completedAt` and `errorMessage` start as null and are set atomically
 *    in a single findOneAndUpdate when the run finishes or fails.
 *  - A virtual `durationMs` computes elapsed time when both timestamps exist,
 *    making it trivial to surface in API responses without extra math.
 */
const reconciliationRunSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(RUN_STATUS),
      required: true,
      default: RUN_STATUS.PENDING,
    },

    /** The exact tolerance config this run was executed with. */
    config: {
      type: runConfigSchema,
      required: true,
    },

    /** Populated once status transitions to 'done'. */
    summary: {
      type: runSummarySchema,
      default: () => ({}),
    },

    /** Absolute path to the generated CSV report file. */
    reportPath: {
      type: String,
      default: null,
    },

    /** Human-readable error message, set only when status is 'failed'. */
    errorMessage: {
      type: String,
      default: null,
    },

    /** Set once, when the run transitions to 'done' or 'failed'. */
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false },
    versionKey: false,
  }
);

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

/**
 * Elapsed time in milliseconds between creation and completion.
 * Returns null if the run has not yet completed.
 */
reconciliationRunSchema.virtual('durationMs').get(function () {
  if (!this.completedAt || !this.createdAt) return null;
  return this.completedAt.getTime() - this.createdAt.getTime();
});

module.exports = mongoose.model('ReconciliationRun', reconciliationRunSchema);
