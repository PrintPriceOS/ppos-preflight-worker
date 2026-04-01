/**
 * QueueManager
 * 
 * Manages BullMQ workers and Redis connections.
 * v2.4.86 - Extreme Performance Patch
 */
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const JobRouter = require('./JobRouter');
const RetryPolicy = require('./RetryPolicy');
const os = require('os');

class QueueManager {
    constructor(redisOptions, logger) {
        this.redisOptions = redisOptions;
        this.logger = logger || console;
        this.workers = [];
        this.heartbeatInterval = null;

        // V1.9.3 Worker Identity
        this.workerId = `preflight-worker-${process.env.NODE_ENV || 'dev'}-${os.hostname()}-${Math.random().toString(36).substring(7)}`;
        this.redisClient = new IORedis(this.redisOptions);

        // Performance Tiering (v2.4.86)
        this.concurrency = parseInt(process.env.WORKER_CONCURRENCY || '50', 10);
        this.lockDuration = parseInt(process.env.WORKER_LOCK_DURATION_MS || '900000', 10);
    }

    /**
     * Start the worker and heartbeat.
     */
    async start(queueName = 'preflight_async_queue') {
        this.logger.info(
            { queueName, workerId: this.workerId, concurrency: this.concurrency, lockDuration: this.lockDuration },
            'Worker consumer starting with visibility heartbeat...'
        );

        const worker = new Worker(
            queueName,
            async (job) => {
                const childLogger = this.logger.child({
                    jobId: job.id,
                    type: job.name,
                    tenantId: job.data.tenantId || job.data.tenant_id,
                    assetId: job.data.assetId || job.data.asset_id,
                    worker: this.workerId
                });

                childLogger.info('Job processing started');
                await job.updateProgress(5);

                try {
                    const result = await JobRouter.route(job, childLogger);
                    await job.updateProgress(100);
                    childLogger.info('Job processing completed');
                    return result;
                } catch (err) {
                    childLogger.error({ error: err.message, stack: err.stack }, 'Job processing failed');
                    throw err;
                }
            },
            {
                connection: this.redisOptions,
                concurrency: this.concurrency,
                lockDuration: this.lockDuration,
                settings: {
                    backoffDelay: RetryPolicy.backoff,
                    maxAttempts: RetryPolicy.maxRetries
                }
            }
        );

        worker.on('completed', (job) => {
            this.logger.info({ jobId: job.id, worker: this.workerId }, 'Job completed successfully');
        });

        worker.on('failed', (job, err) => {
            this.logger.error({ jobId: job?.id, error: err.message, stack: err.stack, worker: this.workerId }, 'Job failed');
        });

        this.workers.push(worker);

        // Start Registry Heartbeat
        this._startHeartbeat(queueName);
    }

    _startHeartbeat(queueName) {
        const beat = async () => {
            try {
                const key = `ppos:worker:${this.workerId}`;
                const metadata = {
                    id: this.workerId,
                    lastSeen: new Date().toISOString(),
                    hostname: os.hostname(),
                    queue: queueName,
                    status: 'ACTIVE'
                };

                await this.redisClient.multi()
                    .set(key, JSON.stringify(metadata), 'EX', 60) // 1 min TTL
                    .sadd('ppos:workers:active', this.workerId)
                    .exec();
            } catch (err) {
                this.logger.warn({ error: err.message }, 'Failed to emit worker heartbeat');
            }
        };

        beat();
        this.heartbeatInterval = setInterval(beat, 30000); // Pulse every 30s
    }

    async stop() {
        this.logger.info({ workerId: this.workerId }, 'Deregistering worker node...');
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

        try {
            // Explicitly close BullMQ workers (v2.4.86 fix)
            for (const worker of this.workers) {
                await worker.close();
            }

            await this.redisClient.multi()
                .del(`ppos:worker:${this.workerId}`)
                .srem('ppos:workers:active', this.workerId)
                .exec();
        } catch (err) {
            this.logger.error({ error: err.message }, 'Failed to cleanup worker registry');
        } finally {
            await this.redisClient.quit();
        }
    }
}

module.exports = QueueManager;
