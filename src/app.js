'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const config = require('./config');
const logger = require('./logger');
const apiRouter = require('./routes/api');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());

// ---------------------------------------------------------------------------
// Swagger / OpenAPI
// ---------------------------------------------------------------------------

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Crypto Transaction Reconciliation Engine API',
      version: '1.0.0',
      description:
        'RESTful API for reconciling user and exchange crypto transaction exports. ' +
        'Trigger async reconciliation runs, poll for status, and retrieve structured reports.',
    },
    servers: [{ url: `http://localhost:${config.port}`, description: 'Local development' }],
  },
  apis: [path.join(__dirname, 'routes/*.js'), __filename],
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/', apiRouter);

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check
 *     description: Returns service status and MongoDB connection readyState.
 *     tags:
 *       - System
 *     responses:
 *       200:
 *         description: Service is healthy
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
 *                   description: "0=disconnected, 1=connected, 2=connecting, 3=disconnecting"
 *                   example: 1
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', dbState: mongoose.connection.readyState });
});

// ---------------------------------------------------------------------------
// Error handlers
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Four-argument signature is required for Express to treat this as an error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function start() {
  try {
    await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
    logger.info('MongoDB connected', { uri: config.mongodbUri });

    app.listen(config.port, () => {
      logger.info('Server started', { port: config.port });
      logger.info(`Swagger UI available at http://localhost:${config.port}/api-docs`);
    });
  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
}

start();
