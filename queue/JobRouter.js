const AnalyzeProcessor = require('../processors/AnalyzeProcessor');
const AutofixProcessor = require('../processors/AutofixProcessor');
const CircuitBreaker = require('../resilience/CircuitBreaker');
const { db } = require('@ppos/shared-infra');

class JobRouter {
    static async route(job, logger = console) {
        // Phase 2: Unpack normalized job envelope
        const { 
            jobId, 
            tenantId, 
            requestedBy, 
            deploymentId, 
            tenantIsolation, 
            serviceTier, 
            payload,
            requestId = `worker_${job.id}` // Phase 7: Propagate requestId
        } = job.data;

        if (!tenantId) {
            throw new Error(`CRITICAL: Job ${job.id} has NO tenantId. Isolation boundary breached.`);
        }

        const context = {
             auth: { userId: requestedBy, tenantId, role: job.data.userRole || 'member' },
             deployment: { deploymentId, tenantIsolation, serviceTier },
             request: { requestId }
        };

        // Update to PROCESSING
        await db.execute("UPDATE jobs SET status = 'PROCESSING', updated_at = NOW() WHERE id = ?", [jobId]);

        // Phase 7: Audit JOB_STARTED
        const auditLogger = require('../../ppos-preflight-service/src/services/auditLogger');
        await auditLogger.log(context, {
             action: 'JOB_STARTED',
             resourceType: 'JOB',
             resourceId: jobId
        });

        logger.info({ requestId, route: job.name, tenantId, jobId }, 'Routing job with contract-governed context');

        const entityId = payload?.assetId || payload?.asset_id || jobId;
        if (entityId && CircuitBreaker.isOpen(entityId)) {
            await db.execute("UPDATE jobs SET status = 'FAILED' WHERE id = ?", [jobId]);
            throw new Error(`CRITICAL: Entity ${entityId} is in QUARANTINE. Operation aborted.`);
        }

        try {
            let result;
            switch (job.name) {
                case 'ANALYZE':
                    result = await AnalyzeProcessor.process(job.data, logger);
                    break;
                case 'AUTOFIX':
                    result = await AutofixProcessor.process(job.data, logger);
                    break;
                default:
                    throw new Error(`UNSUPPORTED_JOB_TYPE: ${job.name}`);
            }

            // Phase 3: Record Completion and Usage
            const status = job.name === 'ANALYZE' ? 'COMPLETED' : 'FIXED';
            await db.execute(
                "UPDATE jobs SET status = ?, updated_at = NOW() WHERE id = ?",
                [status, jobId]
            );

            // Record Usage Event
            if (result.report?.document?.page_count) {
                await db.execute(
                    "INSERT INTO usage_events (tenant_id, deployment_id, job_id, metric, value) VALUES (?, ?, ?, ?, ?)",
                    [tenantId, deploymentId, jobId, 'PREFLIGHT_PAGES', result.report.document.page_count]
                );
            }

            // Phase 7: Final Audit Evidence
            const auditLogger = require('../../ppos-preflight-service/src/services/auditLogger');
            await auditLogger.log(context, {
                 action: `JOB_${status}`,
                 resourceType: 'JOB',
                 resourceId: jobId
            });

            return result;

        } catch (err) {
            // Track failure for circuit breaker and DB
            CircuitBreaker.recordFailure(entityId, err);
            await db.execute("UPDATE jobs SET status = 'FAILED', updated_at = NOW() WHERE id = ?", [jobId]);
            throw err;
        }
    }
}

module.exports = JobRouter;
