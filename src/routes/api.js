'use strict';

const path = require('path');
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');

const config = require('../config');
const { parseCSV } = require('../ingestion/parser');
const { loadTransactions } = require('../ingestion/loader');
const { matchTransactions } = require('../matching/engine');
const { generateReport, readReport } = require('../reporting/report');
const ReconciliationRun = require('../models/ReconciliationRun');

const router = Router();

// Paths to the CSV data files (relative to project root)
const DATA_DIR = path.resolve(__dirname, '../../data');
const USER_CSV = path.join(DATA_DIR, 'user_transactions.csv');
const EXCHANGE_CSV = path.join(DATA_DIR, 'exchange_transactions.csv');

// ---------------------------------------------------------------------------
// Background reconciliation processor
// ---------------------------------------------------------------------------

/**
 * Runs the full reconciliation pipeline in the background (not awaited by the
 * HTTP handler). Updates the ReconciliationRun document throughout.
 *
 * @param {string} runId
 * @param {{ timestampToleranceSecs: number, quantityTolerancePct: number }} runConfig
 */
async function runReconciliation(runId, runConfig) {
  try {
    await ReconciliationRun.findOneAndUpdate(
      { runId },
      { status: 'running' }
    );

    // 1. Parse both CSVs
    const userResult = parseCSV(USER_CSV, 'user');
    const exchangeResult = parseCSV(EXCHANGE_CSV, 'exchange');

    console.log(`[${runId}] Parsed: user=${userResult.stats.total} rows (${userResult.stats.flagged} flagged), exchange=${exchangeResult.stats.total} rows (${exchangeResult.stats.flagged} flagged)`);

    // 2. Load into MongoDB
    const [userLoad, exchangeLoad] = await Promise.all([
      loadTransactions(userResult.rows, runId, 'user'),
      loadTransactions(exchangeResult.rows, runId, 'exchange'),
    ]);

    console.log(`[${runId}] Inserted: user=${userLoad.inserted}, exchange=${exchangeLoad.inserted}`);

    // 3. Run matching engine
    const results = await matchTransactions(runId, runConfig);

    console.log(`[${runId}] Matching complete: matched=${results.matched.length}, conflicting=${results.conflicting.length}, unmatchedUser=${results.unmatchedUser.length}, unmatchedExchange=${results.unmatchedExchange.length}`);

    // 4. Generate CSV report
    const reportPath = await generateReport(runId, results);

    console.log(`[${runId}] Report written to ${reportPath}`);

    // 5. Update run document with final summary
    const totalFlagged =
      userResult.stats.flagged + exchangeResult.stats.flagged;

    await ReconciliationRun.findOneAndUpdate(
      { runId },
      {
        status: 'done',
        reportPath,
        completedAt: new Date(),
        summary: {
          matched: results.matched.length,
          conflicting: results.conflicting.length,
          unmatchedUser: results.unmatchedUser.length,
          unmatchedExchange: results.unmatchedExchange.length,
          totalFlagged,
        },
      }
    );
  } catch (err) {
    console.error(`[${runId}] Reconciliation failed:`, err);
    await ReconciliationRun.findOneAndUpdate(
      { runId },
      { status: 'failed', errorMessage: err.message }
    ).catch(() => {});
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
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Failed to start reconciliation run"
 *                 detail:
 *                   type: string
 *                   example: "Error message details"
 */
router.post('/reconcile', async (req, res) => {
  try {
    const runId = uuidv4();

    // Merge request-body overrides with env defaults (body takes precedence)
    const runConfig = {
      timestampToleranceSecs:
        req.body.timestampToleranceSecs !== undefined
          ? Number(req.body.timestampToleranceSecs)
          : config.timestampToleranceSecs,
      quantityTolerancePct:
        req.body.quantityTolerancePct !== undefined
          ? Number(req.body.quantityTolerancePct)
          : config.quantityTolerancePct,
    };

    // Create the run record in a 'pending' state
    await ReconciliationRun.create({
      runId,
      status: 'pending',
      config: runConfig,
    });

    // Fire-and-forget — do NOT await
    runReconciliation(runId, runConfig);

    return res.status(202).json({ runId, status: 'running' });
  } catch (err) {
    console.error('POST /reconcile error:', err);
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
 *                   example: "running"
 *                 message:
 *                   type: string
 *                   example: "Reconciliation is not yet complete."
 *       404:
 *         description: Run or report file not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Run not found: 550e8400-e29b-41d4-a716-446655440000"
 *       500:
 *         description: Server error
 */
router.get('/report/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const run = await ReconciliationRun.findOne({ runId }).lean();

    if (!run) {
      return res.status(404).json({ error: `Run not found: ${runId}` });
    }

    if (run.status !== 'done') {
      return res.status(202).json({
        runId,
        status: run.status,
        message: 'Reconciliation is not yet complete.',
      });
    }

    const rows = readReport(runId);
    if (!rows) {
      return res.status(404).json({ error: `Report file not found for run: ${runId}` });
    }

    return res.status(200).json({ runId, total: rows.length, rows });
  } catch (err) {
    console.error('GET /report/:runId error:', err);
    return res.status(500).json({ error: 'Failed to fetch report', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /report/:runId/summary — counts only
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
 *                 errorMessage:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *       404:
 *         description: Run not found
 *       500:
 *         description: Server error
 */
router.get('/report/:runId/summary', async (req, res) => {
  try {
    const { runId } = req.params;
    const run = await ReconciliationRun.findOne({ runId }).lean();

    if (!run) {
      return res.status(404).json({ error: `Run not found: ${runId}` });
    }

    return res.status(200).json({
      runId: run.runId,
      status: run.status,
      config: run.config,
      summary: run.summary,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      errorMessage: run.errorMessage || null,
    });
  } catch (err) {
    console.error('GET /report/:runId/summary error:', err);
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

    if (!run) {
      return res.status(404).json({ error: `Run not found: ${runId}` });
    }

    if (run.status !== 'done') {
      return res.status(202).json({
        runId,
        status: run.status,
        message: 'Reconciliation is not yet complete.',
      });
    }

    const rows = readReport(runId);
    if (!rows) {
      return res.status(404).json({ error: `Report file not found for run: ${runId}` });
    }

    const unmatched = rows.filter(
      (r) => r.category === 'UNMATCHED_USER' || r.category === 'UNMATCHED_EXCHANGE'
    );

    return res.status(200).json({
      runId,
      unmatchedCount: unmatched.length,
      rows: unmatched,
    });
  } catch (err) {
    console.error('GET /report/:runId/unmatched error:', err);
    return res.status(500).json({ error: 'Failed to fetch unmatched rows', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// OpenAPI Schema Components
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
 *           example: "MATCHED"
 *         reason:
 *           type: string
 *           description: Match explanation or mismatch reasoning
 *           example: "Exact Match"
 *         matchDetails:
 *           type: string
 *           description: Additional matching insights
 *           example: "matched with exchange txId: tx-998"
 *         user_txId:
 *           type: string
 *           example: "tx-user-001"
 *         user_timestamp:
 *           type: string
 *           format: date-time
 *           example: "2026-05-24T11:00:00.000Z"
 *         user_type:
 *           type: string
 *           enum: [deposit, withdrawal, buy, sell]
 *           example: "buy"
 *         user_asset:
 *           type: string
 *           example: "BTC"
 *         user_quantity:
 *           type: number
 *           example: 0.125
 *         exchange_txId:
 *           type: string
 *           example: "tx-exch-001"
 *         exchange_timestamp:
 *           type: string
 *           format: date-time
 *           example: "2026-05-24T11:02:15.000Z"
 *         exchange_type:
 *           type: string
 *           enum: [deposit, withdrawal, buy, sell]
 *           example: "buy"
 *         exchange_asset:
 *           type: string
 *           example: "BTC"
 *         exchange_quantity:
 *           type: number
 *           example: 0.125
 */

module.exports = router;
