/**
 * QueueManager
 * 
 * Manages BullMQ workers and Redis connections.
 */
const { Worker } = require('bullmq');
const JobRouter = require('./JobRouter');
const RetryPolicy = require('./RetryPolicy');

class QueueManager {
    constructor(redisOptions, logger) {
        this.redisOptions = redisOptions;
        this.logger = logger || console;
        this.workers = [];
    }

    /**
     * Start the worker.
     */
    start(queueName = 'preflight_async_queue') {
        this.logger.info({ queueName }, 'Worker consumer starting...');
        
        const worker = new Worker(queueName, async (job) => {
            this.logger.info({ jobId: job.id, type: job.name }, 'Job started');
            return await JobRouter.route(job);
        }, {
            connection: this.redisOptions,
            settings: {
                backoffDelay: RetryPolicy.backoff,
                maxAttempts: RetryPolicy.maxRetries
            }
        });

        worker.on('completed', (job) => {
            this.logger.info({ jobId: job.id }, 'Job completed successfully');
        });

        worker.on('failed', (job, err) => {
            this.logger.error({ jobId: job?.id, error: err.message, stack: err.stack }, 'Job failed');
        });

        this.workers.push(worker);
    }
}

module.exports = QueueManager;
