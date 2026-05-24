'use strict';

const mongoose = require('mongoose');

/**
 * ReconciliationRun Schema
 *
 * Tracks metadata and summary for each reconciliation execution.
 * Results are stored in a separate `reports/{runId}.csv` file;
 * the path is recorded here for retrieval.
 */
const reconciliationRunSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'failed'],
      default: 'pending',
    },
    config: {
      timestampToleranceSecs: Number,
      quantityTolerancePct: Number,
    },
    summary: {
      matched: { type: Number, default: 0 },
      conflicting: { type: Number, default: 0 },
      unmatchedUser: { type: Number, default: 0 },
      unmatchedExchange: { type: Number, default: 0 },
      totalFlagged: { type: Number, default: 0 },
    },
    reportPath: {
      type: String,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: false }
);

module.exports = mongoose.model('ReconciliationRun', reconciliationRunSchema);
