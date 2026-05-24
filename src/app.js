'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const config = require('./config');
const apiRouter = require('./routes/api');

const app = express();

// Parse JSON request bodies
app.use(express.json());

// Swagger API specification options
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Crypto Transaction Reconciliation Engine API',
      version: '1.0.0',
      description: 'RESTful API documentation for the crypto transaction reconciliation engine. Coordinates ingestion of user/exchange CSV files, execution of matching rules, and status reporting.',
    },
    servers: [
      {
        url: `http://localhost:${config.port}`,
        description: 'Development Server',
      },
    ],
  },
  apis: [path.join(__dirname, 'routes/*.js'), __filename],
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

// Serve Swagger UI documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount API routes
app.use('/', apiRouter);

/**
 * @openapi
 * /health:
 *   get:
 *     summary: API health and database connection check
 *     description: Returns the status of the engine and the MongoDB database connection ready state.
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: Service is healthy and database is reachable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "ok"
 *                 dbState:
 *                   type: integer
 *                   description: Mongoose connection readyState (0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting)
 *                   example: 1
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', dbState: mongoose.connection.readyState });
});

// 404 handler for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// ---------------------------------------------------------------------------
// Bootstrap: connect MongoDB then start server
// ---------------------------------------------------------------------------

async function start() {
  try {
    await mongoose.connect(config.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`MongoDB connected: ${config.mongodbUri}`);

    app.listen(config.port, () => {
      console.log(`Reconciliation Engine listening on port ${config.port}`);
      console.log(`  POST /reconcile          — trigger a run`);
      console.log(`  GET  /report/:runId      — full report (JSON)`);
      console.log(`  GET  /report/:runId/summary   — counts only`);
      console.log(`  GET  /report/:runId/unmatched — unmatched rows`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();
