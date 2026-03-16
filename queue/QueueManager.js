/**
 * QueueManager
 * 
 * Manages BullMQ workers and Redis connections.
 */
const { Worker } = require('bullmq');
const JobRouter = require('./JobRouter');
const RetryPolicy = require('./RetryPolicy');

class QueueManager {
    constructor(redisOptions) {
        this.redisOptions = redisOptions;
        this.workers = [];
    }

    /**
     * Start the worker.
     */
    start(queueName = 'preflight_async_queue') {
        console.log(`[WORKER] Starting consumer for queue: ${queueName}`);
        
        const worker = new Worker(queueName, async (job) => {
            console.log(`[WORKER] Job ${job.id} started. Type: ${job.name}`);
            return await JobRouter.route(job);
        }, {
            connection: this.redisOptions,
            settings: {
                backoffDelay: RetryPolicy.backoff,
                maxAttempts: RetryPolicy.maxRetries
            }
        });

        worker.on('completed', (job) => {
            console.log(`[WORKER] Job ${job.id} completed.`);
        });

        worker.on('failed', (job, err) => {
            console.error(`[WORKER] Job ${job.id} failed: ${err.message}`);
        });

        this.workers.push(worker);
    }
}

module.exports = QueueManager;
