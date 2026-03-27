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

// Phase 10 — Health & Readiness Center (Honest Reporting)
const healthServer = http.createServer(async (req, res) => {
    if (req.url === '/health') {
        let redisStatus = 'connected';
        try {
            // Honest check: Ping Redis with 1s timeout
            await Promise.race([
                manager.redisClient.ping(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 1000))
            ]);
        } catch (err) {
            redisStatus = 'disconnected';
            logger.error({ error: err.message }, 'Health Check: Redis connection probe failed');
        }

        const isOperational = redisStatus === 'connected';
        res.writeHead(isOperational ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: isOperational ? 'UP' : 'DOWN', 
            service: 'ppos-preflight-worker',
            queue: queueName,
            redis: redisStatus,
            engine: 'READY',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

const HEALTH_PORT = process.env.HEALTH_PORT || 8002;
healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info({ port: HEALTH_PORT }, 'PrintPrice OS health monitoring active');
});

// Start the Governed execution node (Phase 10 Evolution)
manager.start(queueName).catch(err => {
    logger.fatal({ error: err.message }, 'CRITICAL: Worker node failed to initialize');
    process.exit(1);
});

// Graceful Shutdown Protocol
const shutdown = async () => {
    logger.info('Performing graceful shutdown of governed node...');
    healthServer.close();
    await manager.stop();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
