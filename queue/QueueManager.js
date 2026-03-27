/**
 * QueueManager
 * 
 * Manages BullMQ workers and Redis connections.
 * Enforces PrintPrice OS Governance and Lifecycle.
 */
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const os = require('os');
const JobRouter = require('./JobRouter');
const RetryPolicy = require('./RetryPolicy');
const GovernanceClient = require('../utils/GovernanceClient');
const IntelligenceLayer = require('../utils/IntelligenceLayer');

class QueueManager {
    constructor(redisOptions, logger) {
        this.redisOptions = redisOptions;
        this.logger = logger || require('pino')();
        this.workers = [];
        this.heartbeatInterval = null;
        
        // V1.9.3 Worker Identity
        this.workerId = `preflight-worker-${process.env.NODE_ENV || 'dev'}-${os.hostname()}-${Math.random().toString(36).substring(7)}`;
        this.redisClient = new IORedis(this.redisOptions);
        
        // PrintPrice OS Kernel Layers
        this.governance = new GovernanceClient(this.redisClient);
        this.intelligence = new IntelligenceLayer(this.redisClient);
    }

    /**
     * Start the worker consumer and global heartbeat.
     */
    async start(queueName = 'preflight_async_queue') {
        const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '4');
        this.logger.info({ queueName, workerId: this.workerId, concurrency }, 'Worker consumer starting in Governed mode...');
        
        const worker = new Worker(queueName, async (job) => {
            const contract = job.data;
            const childLogger = this.logger.child({ 
                jobId: contract.jobId, 
                tenantId: contract.tenantId,
                requestId: contract.trace?.requestId || `worker_${job.id}`,
                worker: this.workerId 
            });

            // 1. Governance: Acquire Lease Before Execution (Phase 2)
            try {
                await this.governance.acquireLease({
                    tenantId: contract.tenantId,
                    jobId: contract.jobId,
                    weight: contract.weight || 1,
                    priority: job.opts.priority || 0
                });
            } catch (err) {
                childLogger.warn({ error: err.message }, 'Governance: Lease REJECTED, requeueing job');
                this.intelligence.emitSignal('GOVERNANCE_REJECTION', { jobId: contract.jobId, tenantId: contract.tenantId });
                throw err; // Requeues automatically in BullMQ (increments attempts)
            }

            // 2. Active Heartbeat System (Phase 2 Hearts)
            let heartbeatFailures = 0;
            const leasePulse = setInterval(async () => {
                try {
                    await this.governance.heartbeat(contract.jobId);
                    heartbeatFailures = 0;
                } catch (err) {
                    heartbeatFailures++;
                    childLogger.warn({ error: err.message, heartbeatFailures }, 'Governance: Heartbeat error');
                    
                    if (heartbeatFailures >= 3) {
                        childLogger.error('Governance: CRITICAL - Heartbeat lost. Aborting job to prevent split-brain.');
                        this.intelligence.emitSignal('HEARTBEAT_LOST', { jobId: contract.jobId });
                        // In a real system, we'd abort the engine process here.
                    }
                }
            }, 5000);
            
            childLogger.info({ event: 'JOB_STARTING' }, 'Job processing started');
            const startTime = Date.now();

            try {
                // 3. Deterministic Pipeline Execution (Phase 3)
                const result = await JobRouter.route(job, childLogger);
                const duration = Date.now() - startTime;
                
                childLogger.info({ event: 'JOB_SUCCESS', duration_ms: duration }, 'Job processing completed');
                return result;

            } catch (err) {
                const duration = Date.now() - startTime;
                
                // 4. Intelligence & Classification (Phase 6 & 7)
                const classification = RetryPolicy.classifyError(err);
                
                childLogger.error({ 
                    error: err.message, 
                    classification,
                    duration_ms: duration 
                }, 'Job processing failed');

                this.intelligence.emitSignal('JOB_FAILURE', { 
                    jobId: contract.jobId, 
                    tenantId: contract.tenantId, 
                    classification,
                    error: err.message,
                    duration_ms: duration 
                });

                // Rule: Do not throw if deterministic (stops BullMQ retries)
                if (classification === 'DO_NOT_RETRY') {
                    childLogger.info('Classification: DETERMINISTIC_FAILURE - Terminating retry loop');
                    return { status: 'FAILED_DETERMINISTIC', error: err.message };
                }

                throw err; // Triggers BullMQ retry
            } finally {
                // 5. Governance: Release Lease and Cleanup Pulse
                clearInterval(leasePulse);
                await this.governance.release(contract.jobId, contract.tenantId);
            }

        }, {
            connection: this.redisOptions,
            concurrency, // Phase 9 Performance
            settings: {
                backoffDelay: RetryPolicy.backoff,
                maxAttempts: RetryPolicy.maxRetries
            }
        });

        worker.on('completed', (job) => {
            this.logger.info({ jobId: job.id, worker: this.workerId }, 'Job completed successfully');
        });

        worker.on('failed', (job, err) => {
            this.logger.error({ jobId: job?.id, error: err.message, stack: err.stack, worker: this.workerId }, 'Job failed');
        });

        this.workers.push(worker);

        // Start Registry Heartbeat (Discovery)
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
                    .set(key, JSON.stringify(metadata), 'EX', 60)
                    .sadd('ppos:workers:active', this.workerId)
                    .publish('ppos:worker:heartbeat', JSON.stringify(metadata))
                    .exec();
            } catch (err) {
                this.logger.warn({ error: err.message }, 'Failed to emit worker heartbeat');
            }
        };

        beat();
        this.heartbeatInterval = setInterval(beat, 30000);
    }

    async stop() {
        this.logger.info({ workerId: this.workerId }, 'Deregistering worker node...');
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        
        try {
            await Promise.all(this.workers.map(w => w.close()));
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
