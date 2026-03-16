/**
 * PrintPrice OS — Preflight Worker (v1.9.0)
 * 
 * Canonical Entry Point for asynchronous job execution.
 */
require('dotenv').config();
const QueueManager = require('./queue/QueueManager');

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
};

const manager = new QueueManager(redisConfig);

// Start the worker on the standard preflight queue
manager.start(process.env.PPOS_QUEUE_NAME || 'preflight_async_queue');

console.log('[WORKER] Preflight worker node active and listening.');

// Graceful Shutdown
process.on('SIGTERM', async () => {
    console.log('[WORKER] SIGTERM received. Shutting down...');
    // Add cleanup logic here
    process.exit(0);
});
