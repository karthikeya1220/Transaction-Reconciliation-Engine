# Crypto Transaction Reconciliation Engine

A production-grade Node.js backend that ingests two independent CSV transaction exports (user + exchange), matches them using a configurable two-pass algorithm, and produces a structured reconciliation report — exposed over a REST API with async run tracking.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Features](#features)
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [Setup](#setup)
6. [Running the Server](#running-the-server)
7. [Running Tests](#running-tests)
8. [API Reference](#api-reference)
9. [Configuration](#configuration)
10. [Reconciliation Report Format](#reconciliation-report-format)
11. [Data Quality Handling](#data-quality-handling)
12. [Key Design Decisions](#key-design-decisions)

---

## Problem Statement

Cryptocurrency exchanges and users often export transaction data independently. The two datasets can differ in format, naming conventions, timestamp precision, and perspective (e.g. what one party calls a `TRANSFER_OUT`, the other calls a `TRANSFER_IN`). This engine reconciles both datasets row-by-row and categorises every transaction as **Matched**, **Conflicting**, or **Unmatched** — with full auditability of dirty or unparseable rows.

---

## Features

- Dual CSV ingestion with per-row data quality flagging — no silent drops
- Two-pass matching: exact `txId` match → fuzzy proximity match (asset + type + timestamp + quantity)
- `TRANSFER_IN` / `TRANSFER_OUT` treated as opposite perspectives of the same transaction
- Asset alias normalisation at ingestion (`Bitcoin` → `BTC`, `Ethereum` → `ETH`, etc.)
- Configurable timestamp tolerance (seconds) and quantity tolerance (percentage)
- Async reconciliation — `POST /reconcile` returns immediately with a `runId`
- Full REST API: trigger runs, fetch reports, get summary counts, filter unmatched rows
- CSV report output with 13 columns covering both sides of each match
- Interactive Swagger UI at `/api-docs`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 18 |
| Framework | Express.js |
| Database | MongoDB via Mongoose |
| CSV Parsing | csv-parse |
| CSV Writing | csv-stringify |
| API Docs | swagger-jsdoc + swagger-ui-express |
| Config | dotenv |
| Run IDs | uuid v11 |
| Dev Server | nodemon |

---

## Project Structure

```
crypto-reconciliation/
├── src/
│   ├── app.js                     # Entry point — MongoDB connect + Express bootstrap
│   ├── config/
│   │   └── index.js               # Env var config with defaults, Object.freeze()
│   ├── ingestion/
│   │   ├── parser.js              # CSV parsing, normalisation, data quality flagging
│   │   └── loader.js              # Bulk MongoDB insert (ordered: false)
│   ├── matching/
│   │   └── engine.js              # Two-pass matching algorithm + helper predicates
│   ├── models/
│   │   ├── Transaction.js         # Mongoose schema — one row per CSV record
│   │   └── ReconciliationRun.js   # Run metadata, status, summary counts
│   ├── reporting/
│   │   └── report.js              # CSV report generator + readReport() for API
│   └── routes/
│       └── api.js                 # All 4 REST endpoints + OpenAPI JSDoc
├── data/
│   ├── user_transactions.csv      # User-side transaction export
│   └── exchange_transactions.csv  # Exchange-side transaction export
├── test/
│   ├── unit.js                    # 20 unit tests for matching helpers (no framework)
│   └── smoke.js                   # End-to-end smoke test using Node 18 fetch
├── reports/                       # Auto-generated CSV reports (git-ignored)
├── swagger.json                   # Static OpenAPI 3.0 spec export
├── .env.example                   # Environment variable template
├── .gitignore
├── package.json
└── README.md
```

---

## Setup

### Prerequisites

- **Node.js ≥ 18** — required for native `fetch` used in the smoke test
- **MongoDB** — running locally (`mongodb://localhost:27017`) or a MongoDB Atlas URI

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/crypto-reconciliation.git
cd crypto-reconciliation
npm install
```

### Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

```env
# Required
MONGODB_URI=mongodb://localhost:27017/crypto_reconcile

# Optional — these all have defaults
PORT=3000
TIMESTAMP_TOLERANCE_SECONDS=300
QUANTITY_TOLERANCE_PCT=0.01
```

> The server will **throw on startup** if `MONGODB_URI` is missing — no silent misconfiguration.

---

## Running the Server

```bash
npm run dev       # Development — auto-restarts on file changes (nodemon)
npm start         # Production — node src/app.js
```

On startup you will see:

```
MongoDB connected: mongodb://localhost:27017/crypto_reconcile
Reconciliation Engine listening on port 3000
  POST /reconcile          — trigger a run
  GET  /report/:runId      — full report (JSON)
  GET  /report/:runId/summary   — counts only
  GET  /report/:runId/unmatched — unmatched rows
```

Swagger UI is available at **[http://localhost:3000/api-docs](http://localhost:3000/api-docs)**.

---

## Running Tests

### Unit Tests (no server needed)

Tests cover all three matching helper functions: `typesMatch`, `quantitiesMatch`, `timestampsMatch`.

```bash
npm test
# → 20 passed, 0 failed
```

### End-to-End Smoke Test (server must be running)

```bash
npm run test:smoke
```

This will:
1. `POST /reconcile` to trigger a run
2. Poll `GET /report/:runId/summary` every 2 seconds until `status: "done"`
3. Print the full summary
4. Fetch and count unmatched rows from `GET /report/:runId/unmatched`

---

## API Reference

Interactive docs: **`http://localhost:3000/api-docs`**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/health` | Service health + MongoDB connection state |
| `POST` | `/reconcile` | Trigger a new reconciliation run |
| `GET`  | `/report/:runId` | Full report as a JSON array |
| `GET`  | `/report/:runId/summary` | Run status + match counts |
| `GET`  | `/report/:runId/unmatched` | Only unmatched rows with reasons |

### `POST /reconcile`

Starts an asynchronous reconciliation run. Returns immediately with a `runId`.

**Request body** (all fields optional — override `.env` defaults):

```json
{
  "timestampToleranceSecs": 300,
  "quantityTolerancePct": 0.01
}
```

**Response `202`:**

```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running"
}
```

### `GET /report/:runId/summary`

Returns run metadata and match counts. Poll this until `status` is `"done"` or `"failed"`.

```json
{
  "runId": "550e8400-...",
  "status": "done",
  "config": { "timestampToleranceSecs": 300, "quantityTolerancePct": 0.01 },
  "summary": {
    "matched": 22,
    "conflicting": 1,
    "unmatchedUser": 4,
    "unmatchedExchange": 3,
    "totalFlagged": 5
  },
  "createdAt": "2024-01-15T10:00:00.000Z",
  "completedAt": "2024-01-15T10:00:02.341Z"
}
```

---

## Configuration

Tolerances can be set at three levels, in order of precedence:

```
Request body  >  .env file  >  hardcoded default
```

| Variable | Default | Description |
|----------|---------|-------------|
| `TIMESTAMP_TOLERANCE_SECONDS` | `300` | Max difference in seconds for a timestamp to be considered matching |
| `QUANTITY_TOLERANCE_PCT` | `0.01` | Max relative difference in quantity (e.g. `0.01` = 1%) |

---

## Reconciliation Report Format

Each run produces a CSV at `reports/{runId}.csv` with the following columns:

| Column | Description |
|--------|-------------|
| `category` | `MATCHED`, `CONFLICTING`, `UNMATCHED_USER`, `UNMATCHED_EXCHANGE` |
| `reason` | Human-readable match or mismatch explanation |
| `matchDetails` | Timestamp delta (seconds), quantity delta, or mismatch fields |
| `user_txId` | Transaction ID from user file |
| `user_timestamp` | Timestamp from user file (ISO 8601) |
| `user_type` | Transaction type from user file (normalised to uppercase) |
| `user_asset` | Asset from user file (normalised to ticker symbol) |
| `user_quantity` | Quantity from user file |
| `exchange_txId` | Transaction ID from exchange file |
| `exchange_timestamp` | Timestamp from exchange file |
| `exchange_type` | Transaction type from exchange file |
| `exchange_asset` | Asset from exchange file |
| `exchange_quantity` | Quantity from exchange file |

Blank columns on either side indicate an unmatched record from the opposite source.

---

## Data Quality Handling

Rows with issues are **never silently dropped**. Instead they are stored in MongoDB with `isValid: false` and a `dataQualityFlags` array describing each problem:

```json
[
  { "field": "timestamp", "issue": "UNPARSEABLE_TIMESTAMP", "value": "not-a-date" },
  { "field": "quantity",  "issue": "NEGATIVE_QUANTITY",     "value": "-0.05" }
]
```

| Flag | Trigger |
|------|---------|
| `MISSING_TX_ID` | Empty or absent `txId` field |
| `UNPARSEABLE_TIMESTAMP` | Timestamp that cannot be parsed in any supported format |
| `INVALID_QUANTITY` | Non-numeric quantity |
| `NEGATIVE_QUANTITY` | Quantity less than zero |
| `UNKNOWN_ASSET` | Asset not found in alias map or known ticker list |
| `MISSING_TYPE` | Empty or absent transaction type |

**Supported timestamp formats:** ISO 8601, Unix milliseconds (13-digit), Unix seconds (10-digit), `DD/MM/YYYY`, `MM-DD-YYYY`, any JS `Date`-parseable string.

---

## Key Design Decisions

These decisions address requirements that were either ambiguous in the assignment or had multiple valid interpretations.

---

### 1. Async Reconciliation with `runId` (vs. Synchronous Response)

**Decision:** `POST /reconcile` returns `202 Accepted` immediately with a `runId`. The matching pipeline runs in the background.

**Why:** Real CSV exports can contain thousands of rows. A synchronous implementation would block the HTTP response for seconds and risk gateway timeouts in production. The `runId` polling pattern is the standard approach for long-running jobs.

**The unclear requirement:** The assignment said "trigger a reconciliation run" but did not specify whether the response should block until completion. I chose async because it is the production-correct interpretation.

**Tradeoff:** Clients must make a follow-up request to `GET /report/:runId/summary` to check completion.

---

### 2. Two-Pass Matching: Exact `txId` First, then Fuzzy

**Decision:** Pass 1 matches by exact `txId`. Only unmatched transactions proceed to Pass 2 (fuzzy match by asset + type + timestamp proximity + quantity proximity).

**Why:** When a `txId` matches on both sides it is definitively the same transaction — no ambiguity. Skipping directly to fuzzy-only matching risks false positives, especially for high-frequency assets where many trades have similar sizes.

**The unclear requirement:** The assignment specified both matching strategies but did not define the execution order or whether they should be combined or sequential. I chose sequential (exact first) because it is the most conservative and auditable approach.

**Tradeoff:** Transactions without a `txId` (flagged rows) rely entirely on fuzzy matching.

---

### 3. `CONFLICTING` vs `UNMATCHED` for txId Matches with Tolerance Violations

**Decision:** If a `txId` matches on both sides but quantity or timestamp falls outside tolerance, the pair is categorised as `CONFLICTING` — not unmatched.

**Why:** The fact that the IDs match is significant. Labelling these as unmatched would obscure a real discrepancy that needs auditor attention. `CONFLICTING` communicates "we found it but something is wrong."

**The unclear requirement:** The assignment defined `CONFLICTING` but did not specify the exact condition. I defined it as: *txId match found + at least one tolerance violation*.

---

### 4. `TRANSFER_IN` / `TRANSFER_OUT` Are the Same Transaction

**Decision:** When comparing transaction types, `TRANSFER_IN` on the exchange side matches `TRANSFER_OUT` on the user side (and vice versa).

**Why:** A crypto transfer is one real-world event. The exchange records money arriving (`TRANSFER_IN`); the user records money leaving (`TRANSFER_OUT`). Without this rule, every transfer would appear unmatched.

**The unclear requirement:** The assignment mentioned this pairing in the context, but did not specify whether it should apply in both directions. I implemented it symmetrically — either side can have either label.

---

### 5. Normalise Assets at Ingestion Time, Not Match Time

**Decision:** Asset names (`Bitcoin`, `bitcoin`, `BITCOIN`) are all converted to canonical tickers (`BTC`) when the CSV is parsed, before anything is stored in MongoDB.

**Why:** Normalising early means the matching engine just does a simple string equality check. Deferring normalisation to match time would require double-handling and could introduce subtle inconsistencies if raw values leaked into reports.

**Supported aliases:** `Bitcoin→BTC`, `Ethereum→ETH`, `Solana→SOL`, `Dogecoin→DOGE`, `Cardano→ADA`, `Ripple→XRP`, `Litecoin→LTC`, `Polkadot→DOT`, `Chainlink→LINK`.

**Tradeoff:** Unknown aliases are flagged (`UNKNOWN_ASSET`) but not dropped. A new alias requires a code change to the alias map in `parser.js`.

---

### 6. Closest-Timestamp Tie-Breaking in Fuzzy Match

**Decision:** When multiple exchange transactions satisfy all fuzzy criteria for a given user transaction, the one with the smallest absolute timestamp delta is selected.

**Why:** Prevents double-matching (one exchange record being claimed by multiple user records). Smallest timestamp delta is the most intuitive and defensible tiebreaker for financial data — it reflects the transaction most likely to be the real counterpart.

**The unclear requirement:** The assignment did not specify how to handle multiple fuzzy candidates. I chose timestamp proximity as the tiebreaker because it is objective and logged in `matchDetails` for transparency.

---

### 7. Tolerance Precedence: Request Body > Env Var > Default

**Decision:** Tolerances can be set in three places; the request body takes highest precedence, then `.env`, then hardcoded defaults (`300s`, `1%`).

**Why:** Env vars satisfy the "configurable without code changes" requirement. Per-request overrides let callers experiment with different windows (e.g. stricter reconciliation for a specific audit) without restarting the service.

**Hardcoded defaults:** `TIMESTAMP_TOLERANCE_SECONDS=300` (5 minutes), `QUANTITY_TOLERANCE_PCT=0.01` (1%).

---

### 8. Report Stored as CSV File, Served as JSON via API

**Decision:** The reconciliation output is written to `reports/{runId}.csv` on disk. The path is stored in the `ReconciliationRun` MongoDB document. API endpoints read the CSV and return it as a JSON array.

**Why:** The assignment explicitly required CSV output. Storing on disk means the file is independently accessible (e.g. downloadable, openable in Excel) without requiring a database query. Serving JSON from the API keeps the programmatic interface standard.

**The unclear requirement:** The assignment did not specify what `GET /report/:runId` should return. I chose JSON (parsed from the CSV) so API consumers do not have to parse CSV themselves, while the canonical file remains CSV.

---

### 9. Invalid Rows Participate in Matching Where Possible

**Decision:** A flagged row (`isValid: false`) is not automatically excluded from matching. It is excluded from **fuzzy** matching only for the specific fields that are invalid (e.g. a row with an unparseable timestamp cannot fuzzy-match on timestamp, but can still exact-match on `txId`).

**Why:** A row may have a valid `txId` and still have a bad timestamp. Excluding it entirely from all matching would cause a genuine txId match to appear as two unmatched records — which is worse than surfacing it as a match with a flagged field.

**The unclear requirement:** The assignment said to flag but not drop bad rows, but did not say what should happen to them during matching. I implemented the most conservative interpretation: include them where the data is valid, exclude them where it is not.
