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

const ToolPreflight = require('./utils/ToolPreflight');
const manager = new QueueManager(redisConfig, logger);
const queueName = process.env.PPOS_QUEUE_NAME || 'preflight_async_queue';

let toolsStatus = { ready: false, tools: {}, missingTools: [] };

// Minimal Health Check Server for Staging/Production
const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        const statusCode = toolsStatus.ready ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: toolsStatus.ready ? 'UP' : 'UNHEALTHY', 
            service: 'ppos-preflight-worker',
            queue: queueName,
            tools: toolsStatus,
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

const HEALTH_PORT = process.env.HEALTH_PORT || 8002;

async function bootstrap() {
    logger.info('Running deterministic startup preflight check for industrial binaries...');
    toolsStatus = await ToolPreflight.checkAll();

    healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
        logger.info({ port: HEALTH_PORT }, 'Worker health check active');
    });

    if (!toolsStatus.ready) {
        logger.error({ missing: toolsStatus.missingTools, tools: toolsStatus.tools }, '[WORKER][TOOLS][MISSING] Critical industrial tools are missing.');
        logger.fatal('[WORKER][TOOLS][FATAL] Critical binaries unavailable. Refusing to start queue consumer in degraded tool state.');
        // Keep health check server active to report unhealthy state, but do not consume jobs
    } else {
        logger.info({ tools: toolsStatus.tools }, '[WORKER][TOOLS][OK] All critical industrial tools are verified and available.');
        // Start the worker on the standard preflight queue
        manager.start(queueName);
        logger.info({ queue: queueName }, 'Preflight worker node active and listening');
    }
}

bootstrap();

// Graceful Shutdown
const shutdown = async () => {
    logger.info('Shutting down worker node and cleaning registry...');
    healthServer.close();
    await manager.stop();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
