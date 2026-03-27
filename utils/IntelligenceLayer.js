/**
 * IntelligenceLayer
 * 
 * Emits signals from worker nodes to the centralized OS intelligence system.
 * Used for anomaly detection, performance patterns, and forensic auditing.
 */
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

class IntelligenceLayer {
    constructor(redisClient) {
        this.redis = redisClient;
    }

    /**
     * Emits an intelligence signal from the worker node.
     * 
     * @param {string} signalType Type of signal (FAILURE_CLUSTER, SLOW_JOB, etc.)
     * @param {object} metadata Additional context for the signal
     */
    async emitSignal(signalType, metadata = {}) {
        const signal = {
            id: `signal-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            timestamp: new Date().toISOString(),
            type: signalType,
            source: `worker-${process.env.HOSTNAME || 'anon'}`,
            payload: metadata
        };

        logger.info({ signalType, signalId: signal.id, metadata }, `Intelligence Signal: ${signalType} Emitted`);

        try {
            // Logic: Publish to Redis 'ppos:intel:signals' and/or increment metrics
            await this.redis.multi()
                .publish('ppos:intel:signals', JSON.stringify(signal))
                .lpush('ppos:intel:history', JSON.stringify(signal))
                .ltrim('ppos:intel:history', 0, 999) // Keep last 1k signals
                .incr(`ppos:intel:metrics:${signalType}:count`) // Simple counter for analytics
                .exec();

            // Automatic Analysis: Detect retry loops
            if (metadata.jobId && metadata.retries > 3) {
                this.emitSignal('RETRY_LOOP', { jobId: metadata.jobId, tenantId: metadata.tenantId });
            }

            // Detect Execution Time Anomalies
            if (metadata.duration_ms > 60000) { // 1 min threshold
                this.emitSignal('SLOW_JOB', { jobId: metadata.jobId, duration_ms: metadata.duration_ms });
            }

        } catch (err) {
            logger.warn({ error: err.message }, 'Intelligence Layer: Failed to emit signal');
        }
    }
}

module.exports = IntelligenceLayer;
