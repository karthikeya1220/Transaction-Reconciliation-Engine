# Crypto Transaction Reconciliation Engine

## Problem Statement

Cryptocurrency exchanges and users often export transaction data independently, leading to discrepancies due to differing perspectives, data formats, and timing. This engine ingests both datasets, matches transactions using configurable tolerances, and produces a structured reconciliation report — enabling auditors and users to identify matched, conflicting, and unmatched records.

---

## Features

- Dual CSV ingestion with data quality flagging (no silent drops)
- Two-pass matching: exact `txId` match → fuzzy match (timestamp + quantity + asset + type)
- Handles TRANSFER_IN / TRANSFER_OUT as opposite perspectives of the same transaction
- Asset alias normalization (e.g. `Bitcoin` → `BTC`)
- Configurable tolerance for timestamp (seconds) and quantity (percentage)
- Async reconciliation with `runId` tracking
- REST API to trigger runs and fetch reports
- CSV report export with categories: Matched / Conflicting / Unmatched

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB (via Mongoose)
- **CSV Parsing:** csv-parse
- **CSV Writing:** csv-stringify
- **Other:** dotenv, uuid

---

## Project Structure

```
crypto-reconciliation/
├── src/
│   ├── config/index.js            # Env vars + tolerances
│   ├── ingestion/
│   │   ├── parser.js              # CSV parsing + validation
│   │   └── loader.js              # MongoDB insert logic
│   ├── matching/
│   │   └── engine.js              # Core matching algorithm
│   ├── reporting/
│   │   └── report.js              # CSV report generator
│   ├── models/
│   │   ├── Transaction.js         # Transaction schema
│   │   └── ReconciliationRun.js   # Run metadata schema
│   ├── routes/
│   │   └── api.js                 # Express route handlers
│   └── app.js                     # Entry point
├── data/
│   ├── user_transactions.csv
│   └── exchange_transactions.csv
├── reports/                       # Auto-generated CSV reports
├── docs/
│   ├── PROJECT_CONTEXT.md
│   ├── TASKS.md
│   ├── DECISIONS.md
│   └── PROMPTS.md
├── .env
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## Setup

### Prerequisites

- Node.js >= 18
- MongoDB running locally or a MongoDB Atlas URI

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/crypto-reconciliation.git
cd crypto-reconciliation
npm install
```

### Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
MONGODB_URI=mongodb://localhost:27017/crypto_reconcile
PORT=3000
TIMESTAMP_TOLERANCE_SECONDS=300
QUANTITY_TOLERANCE_PCT=0.01
```

### Run

```bash
npm run dev       # Development with nodemon
npm start         # Production
```

---

## API Reference

API documentation is dynamically served via Swagger UI when the server is running. A static OpenAPI 3.0 specification is also available in the root folder.
- **Interactive Swagger UI:** `http://localhost:3000/api-docs`
- **Static OpenAPI Spec:** [`swagger.json`](./swagger.json)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api-docs` | Interactive Swagger API documentation UI |
| `GET`  | `/health` | API health and database connection check |
| `POST` | `/reconcile` | Trigger a reconciliation run |
| `GET`  | `/report/:runId` | Full reconciliation report |
| `GET`  | `/report/:runId/summary` | Counts only (matched, conflicting, unmatched) |
| `GET`  | `/report/:runId/unmatched` | Only unmatched rows with reasons |

### POST `/reconcile`

**Request Body (all optional — overrides env defaults):**

```json
{
  "timestampToleranceSecs": 300,
  "quantityTolerancePct": 0.01
}
```

**Response:**

```json
{
  "runId": "uuid-here",
  "status": "running"
}
```

---

## Configuration

Tolerances can be set via:

1. **Environment variables** in `.env`
2. **Request body** on `POST /reconcile` (takes precedence)

| Variable | Default | Description |
|----------|---------|-------------|
| `TIMESTAMP_TOLERANCE_SECONDS` | `300` | Max seconds difference for a timestamp match |
| `QUANTITY_TOLERANCE_PCT` | `0.01` | Max % difference in quantity for a match |

---

## Reconciliation Report

The output CSV (`reports/{runId}.csv`) contains:

| Column | Description |
|--------|-------------|
| `category` | `MATCHED`, `CONFLICTING`, `UNMATCHED_USER`, `UNMATCHED_EXCHANGE` |
| `reason` | Human-readable explanation |
| `user_txId` | Transaction ID from user file |
| `user_timestamp` | Timestamp from user file |
| `user_type` | Transaction type from user file |
| `user_asset` | Asset from user file |
| `user_quantity` | Quantity from user file |
| `exchange_txId` | Transaction ID from exchange file |
| `exchange_timestamp` | Timestamp from exchange file |
| `exchange_type` | Transaction type from exchange file |
| `exchange_asset` | Asset from exchange file |
| `exchange_quantity` | Quantity from exchange file |
| `matchDetails` | Additional match/mismatch info |

---

## Key Design Decisions

See [`docs/DECISIONS.md`](docs/DECISIONS.md) for full rationale behind architectural choices.

---

## Data Quality

Rows with issues are **not dropped** — they are flagged with a `dataQualityFlags` array indicating the field, issue type, and original value. This ensures full auditability.

Common flags:
- `UNPARSEABLE_TIMESTAMP`
- `NEGATIVE_QUANTITY`
- `MISSING_TX_ID`
- `UNKNOWN_ASSET`
- `MISSING_TYPE`
