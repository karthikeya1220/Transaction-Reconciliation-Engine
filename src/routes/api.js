'use strict';

const path = require('path');
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const logger = require('../logger');
const { RUN_STATUS } = require('../constants');
const { parseCSV } = require('../ingestion/parser');
const { loadTransactions } = require('../ingestion/loader');
const { matchTransactions } = require('../matching/engine');
const { generateReport, readReport } = require('../reporting/report');
const ReconciliationRun = require('../models/ReconciliationRun');

const router = Router();

/** Absolute paths to the canonical input CSV files. */
const DATA_DIR = path.resolve(__dirname, '../../data');
const USER_CSV = path.join(DATA_DIR, 'user_transactions.csv');
const EXCHANGE_CSV = path.join(DATA_DIR, 'exchange_transactions.csv');

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate and coerce a tolerance value from the request body.
 *
 * @param {unknown}  value     Raw value from req.body
 * @param {number}   fallback  Default from config
 * @param {number}   min       Minimum acceptable value
 * @param {number}   max       Maximum acceptable value
 * @param {string}   name      Field name for error messages
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function validateTolerance(value, fallback, min, max, name) {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  const n = Number(value);
  if (isNaN(n)) return { ok: false, error: `${name} must be a number` };
  if (n < min || n > max) return { ok: false, error: `${name} must be between ${min} and ${max}` };
  return { ok: true, value: n };
}

// ---------------------------------------------------------------------------
// Background reconciliation pipeline
// ---------------------------------------------------------------------------

/**
 * Execute the full reconciliation pipeline for a given run.
 *
 * Intentionally separated from the route handler so it can be called
 * fire-and-forget without blocking the HTTP response. Updates the
 * ReconciliationRun document at each lifecycle transition.
 *
 * @param {string} runId
 * @param {{ timestampToleranceSecs: number, quantityTolerancePct: number }} runConfig
 */
async function runReconciliation(runId, runConfig) {
  const log = (msg, meta = {}) => logger.info(msg, { runId, ...meta });
  const logErr = (msg, meta = {}) => logger.error(msg, { runId, ...meta });

  try {
    await ReconciliationRun.findOneAndUpdate({ runId }, { status: RUN_STATUS.RUNNING });
    log('Reconciliation started');

    // Step 1 — Parse CSVs
    const userResult = parseCSV(USER_CSV, 'user');
    const exchangeResult = parseCSV(EXCHANGE_CSV, 'exchange');
    log('CSVs parsed', {
      user: userResult.stats,
      exchange: exchangeResult.stats,
    });

    // Step 2 — Load into MongoDB (parallel)
    const [userLoad, exchangeLoad] = await Promise.all([
      loadTransactions(userResult.rows, runId, 'user'),
      loadTransactions(exchangeResult.rows, runId, 'exchange'),
    ]);
    log('Transactions inserted', { user: userLoad.inserted, exchange: exchangeLoad.inserted });
    if (userLoad.errors.length || exchangeLoad.errors.length) {
      logger.warn('Some documents failed to insert', {
        runId,
        userErrors: userLoad.errors.length,
        exchangeErrors: exchangeLoad.errors.length,
      });
    }

    // Step 3 — Match
    const results = await matchTransactions(runId, runConfig);
    log('Matching complete', {
      matched: results.matched.length,
      conflicting: results.conflicting.length,
      unmatchedUser: results.unmatchedUser.length,
      unmatchedExchange: results.unmatchedExchange.length,
    });

    // Step 4 — Generate CSV report
    const reportPath = await generateReport(runId, results);
    log('Report written', { reportPath });

    // Step 5 — Persist final state
    await ReconciliationRun.findOneAndUpdate(
      { runId },
      {
        status: RUN_STATUS.DONE,
        reportPath,
        completedAt: new Date(),
        summary: {
          matched: results.matched.length,
          conflicting: results.conflicting.length,
          unmatchedUser: results.unmatchedUser.length,
          unmatchedExchange: results.unmatchedExchange.length,
          totalFlagged: userResult.stats.flagged + exchangeResult.stats.flagged,
        },
      }
    );
    log('Run completed successfully');
  } catch (err) {
    logger.error('Reconciliation pipeline failed', { runId, error: err.message, stack: err.stack });
    await ReconciliationRun.findOneAndUpdate(
      { runId },
      { status: RUN_STATUS.FAILED, errorMessage: err.message }
    ).catch((updateErr) => {
      logger.error('Failed to persist error state', { runId, error: updateErr.message });
    });
  }
}

// ---------------------------------------------------------------------------
// POST /reconcile — trigger a new run
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /reconcile:
 *   post:
 *     summary: Trigger a new reconciliation run
 *     description: Starts a background reconciliation process between user and exchange transactions.
 *     tags:
 *       - Reconciliation
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               timestampToleranceSecs:
 *                 type: integer
 *                 description: Time difference tolerance in seconds for transactions to match
 *                 example: 300
 *               quantityTolerancePct:
 *                 type: number
 *                 description: Percentage tolerance for transaction quantities to match (e.g. 0.01 for 1%)
 *                 example: 0.01
 *     responses:
 *       202:
 *         description: Reconciliation run accepted and started in background
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId:
 *                   type: string
 *                   format: uuid
 *                   example: "550e8400-e29b-41d4-a716-446655440000"
 *                 status:
 *                   type: string
 *                   example: "running"
 *       400:
 *         description: Invalid tolerance values
 *       500:
 *         description: Server error
 */
router.post('/reconcile', async (req, res) => {
  try {
    // Validate tolerance overrides from request body
    const tsResult = validateTolerance(
      req.body?.timestampToleranceSecs,
      config.timestampToleranceSecs,
      0, 86400, 'timestampToleranceSecs'
    );
    const qResult = validateTolerance(
      req.body?.quantityTolerancePct,
      config.quantityTolerancePct,
      0, 1, 'quantityTolerancePct'
    );

    if (!tsResult.ok) return res.status(400).json({ error: tsResult.error });
    if (!qResult.ok) return res.status(400).json({ error: qResult.error });

    const runId = uuidv4();
    const runConfig = {
      timestampToleranceSecs: tsResult.value,
      quantityTolerancePct: qResult.value,
    };

    await ReconciliationRun.create({ runId, status: RUN_STATUS.PENDING, config: runConfig });
    logger.info('Reconciliation run created', { runId, config: runConfig });

    // Fire-and-forget — do NOT await
    runReconciliation(runId, runConfig);

    return res.status(202).json({ runId, status: 'running' });
  } catch (err) {
    logger.error('POST /reconcile failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to start reconciliation run', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /report/:runId — full report as JSON
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /report/{runId}:
 *   get:
 *     summary: Fetch full reconciliation report
 *     description: Retrieves the detailed reconciliation report containing matched, conflicting, and unmatched transaction records in JSON format.
 *     tags:
 *       - Reports
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Unique reconciliation run ID
 *     responses:
 *       200:
 *         description: Full report fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId:
 *                   type: string
 *                   format: uuid
 *                 total:
 *                   type: integer
 *                   description: Total number of rows in the report
 *                   example: 100
 *                 rows:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReconciliationRow'
 *       202:
 *         description: Reconciliation run is not complete yet
 *       404:
 *         description: Run or report file not found
 *       500:
 *         description: Server error
 */
router.get('/report/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const run = await ReconciliationRun.findOne({ runId }).lean();

    if (!run) return res.status(404).json({ error: `Run not found: ${runId}` });

    if (run.status !== RUN_STATUS.DONE) {
      return res.status(202).json({
        runId,
        status: run.status,
        message: 'Reconciliation is not yet complete.',
      });
    }

    const rows = readReport(runId);
    if (!rows) return res.status(404).json({ error: `Report file not found for run: ${runId}` });

    return res.status(200).json({ runId, total: rows.length, rows });
  } catch (err) {
    logger.error('GET /report/:runId failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch report', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /report/:runId/summary — counts and metadata only
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /report/{runId}/summary:
 *   get:
 *     summary: Fetch reconciliation summary
 *     description: Retrieves metadata, config settings, and matching statistics for a reconciliation run.
 *     tags:
 *       - Reports
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Unique reconciliation run ID
 *     responses:
 *       200:
 *         description: Summary fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId:
 *                   type: string
 *                   format: uuid
 *                 status:
 *                   type: string
 *                   enum: [pending, running, done, failed]
 *                   example: "done"
 *                 config:
 *                   type: object
 *                   properties:
 *                     timestampToleranceSecs:
 *                       type: integer
 *                       example: 300
 *                     quantityTolerancePct:
 *                       type: number
 *                       example: 0.01
 *                 summary:
 *                   type: object
 *                   properties:
 *                     matched:
 *                       type: integer
 *                       example: 85
 *                     conflicting:
 *                       type: integer
 *                       example: 5
 *                     unmatchedUser:
 *                       type: integer
 *                       example: 10
 *                     unmatchedExchange:
 *                       type: integer
 *                       example: 12
 *                     totalFlagged:
 *                       type: integer
 *                       example: 3
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *                 completedAt:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 durationMs:
 *                   type: integer
 *                   nullable: true
 *                   description: Elapsed time in milliseconds from creation to completion
 *                 errorMessage:
 *                   type: string
 *                   nullable: true
 *       404:
 *         description: Run not found
 *       500:
 *         description: Server error
 */
router.get('/report/:runId/summary', async (req, res) => {
  try {
    const { runId } = req.params;
    // Use the non-lean form here to access the durationMs virtual
    const run = await ReconciliationRun.findOne({ runId });

    if (!run) return res.status(404).json({ error: `Run not found: ${runId}` });

    return res.status(200).json({
      runId: run.runId,
      status: run.status,
      config: run.config,
      summary: run.summary,
      createdAt: run.createdAt,
      completedAt: run.completedAt ?? null,
      durationMs: run.durationMs ?? null,
      errorMessage: run.errorMessage ?? null,
    });
  } catch (err) {
    logger.error('GET /report/:runId/summary failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch summary', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /report/:runId/unmatched — unmatched rows only
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /report/{runId}/unmatched:
 *   get:
 *     summary: Fetch unmatched records only
 *     description: Filter and return only the unmatched user and exchange records from the reconciliation report.
 *     tags:
 *       - Reports
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Unique reconciliation run ID
 *     responses:
 *       200:
 *         description: Unmatched records fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 runId:
 *                   type: string
 *                   format: uuid
 *                 unmatchedCount:
 *                   type: integer
 *                   example: 22
 *                 rows:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ReconciliationRow'
 *       202:
 *         description: Reconciliation run is not complete yet
 *       404:
 *         description: Run or report not found
 *       500:
 *         description: Server error
 */
router.get('/report/:runId/unmatched', async (req, res) => {
  try {
    const { runId } = req.params;
    const run = await ReconciliationRun.findOne({ runId }).lean();

    if (!run) return res.status(404).json({ error: `Run not found: ${runId}` });

    if (run.status !== RUN_STATUS.DONE) {
      return res.status(202).json({
        runId,
        status: run.status,
        message: 'Reconciliation is not yet complete.',
      });
    }

    const rows = readReport(runId);
    if (!rows) return res.status(404).json({ error: `Report file not found for run: ${runId}` });

    const unmatched = rows.filter(
      (r) => r.category === 'UNMATCHED_USER' || r.category === 'UNMATCHED_EXCHANGE'
    );

    return res.status(200).json({ runId, unmatchedCount: unmatched.length, rows: unmatched });
  } catch (err) {
    logger.error('GET /report/:runId/unmatched failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch unmatched rows', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// OpenAPI shared component schemas
// ---------------------------------------------------------------------------

/**
 * @openapi
 * components:
 *   schemas:
 *     ReconciliationRow:
 *       type: object
 *       properties:
 *         category:
 *           type: string
 *           enum: [MATCHED, CONFLICTING, UNMATCHED_USER, UNMATCHED_EXCHANGE]
 *         reason:
 *           type: string
 *         matchDetails:
 *           type: string
 *         user_txId:
 *           type: string
 *         user_timestamp:
 *           type: string
 *           format: date-time
 *         user_type:
 *           type: string
 *         user_asset:
 *           type: string
 *         user_quantity:
 *           type: number
 *         exchange_txId:
 *           type: string
 *         exchange_timestamp:
 *           type: string
 *           format: date-time
 *         exchange_type:
 *           type: string
 *         exchange_asset:
 *           type: string
 *         exchange_quantity:
 *           type: number
 */

module.exports = router;
