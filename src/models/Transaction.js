'use strict';

const mongoose = require('mongoose');

/**
 * Transaction Schema
 *
 * Stores one parsed CSV row from either the user or exchange dataset.
 * Rows with data quality issues are NOT dropped — they are stored with
 * isValid=false and a populated dataQualityFlags array.
 */
const transactionSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['user', 'exchange'],
      required: true,
    },
    txId: {
      type: String,
      default: null, // optional — may be missing in dirty data
    },
    timestamp: {
      type: Date,
      default: null, // optional — may fail to parse
    },
    type: {
      type: String, // normalized to uppercase
      default: null,
    },
    asset: {
      type: String, // normalized to ticker symbol (e.g. 'BTC')
      default: null,
    },
    quantity: {
      type: Number,
      default: null,
    },
    rawRow: {
      type: mongoose.Schema.Types.Mixed, // original CSV row preserved verbatim
    },
    dataQualityFlags: [
      {
        field: String,
        issue: String,
        value: String,
        _id: false,
      },
    ],
    isValid: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: false }
);

// Compound index for efficient per-run, per-source queries
transactionSchema.index({ runId: 1, source: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
