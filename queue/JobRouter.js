/**
 * JobRouter
 * 
 * Routes incoming jobs to their respective processors.
 */
const AnalyzeProcessor = require('../processors/AnalyzeProcessor');
const AutofixProcessor = require('../processors/AutofixProcessor');
const CircuitBreaker = require('../resilience/CircuitBreaker');

class JobRouter {
    static async route(job) {
        // V1.9.0 Circuit Breaker Guard (Support both camelCase and snake_case)
        const entityId = job.data.asset_id || job.data.assetId || job.data.job_id || job.data.jobId;
        if (entityId && CircuitBreaker.isOpen(entityId)) {
            throw new Error(`CRITICAL: Entity ${entityId} is in QUARANTINE. Operation aborted.`);
        }

        try {
            switch (job.name) {
                case 'ANALYZE':
                    return await AnalyzeProcessor.process(job.data);
                case 'AUTOFIX':
                    return await AutofixProcessor.process(job.data);
                default:
                    throw new Error(`UNSUPPORTED_JOB_TYPE: ${job.name}`);
            }
        } catch (err) {
            // Track failure for circuit breaker
            CircuitBreaker.recordFailure(entityId, err);
            throw err;
        }
    }
}

module.exports = JobRouter;
