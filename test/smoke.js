#!/usr/bin/env node
'use strict';

/**
 * smoke.js — End-to-end smoke test using Node 18+ built-in fetch.
 *
 * Usage:
 *   node test/smoke.js
 *
 * Expects the server to be running on http://localhost:3000.
 */

const BASE = 'http://localhost:3000';
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30; // 60 seconds max wait

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Crypto Reconciliation Smoke Test ===\n');

  // 1. Trigger a reconciliation run
  console.log('1. POST /reconcile ...');
  const reconcileRes = await fetch(`${BASE}/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!reconcileRes.ok) {
    const err = await reconcileRes.text();
    console.error('Failed to start reconciliation:', err);
    process.exit(1);
  }

  const { runId } = await reconcileRes.json();
  console.log(`   → runId: ${runId}\n`);

  // 2. Poll summary until status is 'done'
  console.log('2. Polling GET /report/:runId/summary ...');
  let summary;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);

    const summaryRes = await fetch(`${BASE}/report/${runId}/summary`);
    summary = await summaryRes.json();

    console.log(`   [poll ${i + 1}] status=${summary.status}`);

    if (summary.status === 'done' || summary.status === 'failed') break;
  }

  console.log('\n--- Summary ---');
  console.log(JSON.stringify(summary, null, 2));

  if (summary.status === 'failed') {
    console.error('\nRun failed:', summary.errorMessage);
    process.exit(1);
  }

  // 3. Fetch unmatched rows
  console.log('\n3. GET /report/:runId/unmatched ...');
  const unmatchedRes = await fetch(`${BASE}/report/${runId}/unmatched`);
  const unmatched = await unmatchedRes.json();
  console.log(`   → ${unmatched.unmatchedCount} unmatched rows`);

  if (unmatched.rows && unmatched.rows.length > 0) {
    console.log('\n   First 5 unmatched:');
    unmatched.rows.slice(0, 5).forEach((r, i) => {
      const side = r.category === 'UNMATCHED_USER' ? 'user' : 'exchange';
      const txId = r.user_txId || r.exchange_txId || '(no txId)';
      console.log(`   [${i + 1}] ${r.category} | txId=${txId} | reason=${r.reason}`);
    });
  }

  console.log('\n✅ Smoke test complete.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
