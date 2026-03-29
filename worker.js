/**
 * PrintPrice OS — Preflight Worker (v1.9.0)
 * 
 * Canonical Entry Point for asynchronous job execution.
 */
require('dotenv').config();
const pino = require('pino');
const http = require('http');
const QueueManager = require('./queue/QueueManager');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
};

const manager = new QueueManager(redisConfig, logger);
const queueName = process.env.PPOS_QUEUE_NAME || 'preflight_async_queue';

// Minimal Health Check Server for Staging/Production
const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'UP', 
            service: 'ppos-preflight-worker',
            queue: queueName,
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

const HEALTH_PORT = process.env.HEALTH_PORT || 8002;
healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info({ port: HEALTH_PORT }, 'Worker health check active');
});

// Start the worker on the standard preflight queue
manager.start(queueName);
logger.info({ queue: queueName }, 'Preflight worker node active and listening');

// Graceful Shutdown
const shutdown = async () => {
    logger.info('Shutting down worker node and cleaning registry...');
    healthServer.close();
    await manager.stop();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
