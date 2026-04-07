const AnalyzeProcessor = require('../processors/AnalyzeProcessor');
const AutofixProcessor = require('../processors/AutofixProcessor');
const CircuitBreaker = require('../resilience/CircuitBreaker');
const AuditLogger = require('../utils/AuditLogger');
const db = require('@ppos/shared-infra/packages/data/db');

class JobRouter {
    /**
     * Routes BullMQ jobs with strict governance and telemetry.
     */
    static async route(job, logger = console) {
        // Phase 1 & 2: Canonical contract enforcement
        const jobType = job?.name;
        const data = job?.data || {};
        const { jobId, tenantId, input, payload, policyProfile, trace = {} } = data;

        const requestId = trace.requestId || `worker_${job.id}`;
        const audit = new AuditLogger(db);

        // Core identifiers required for ALL jobs
        if (!jobId || !tenantId) {
            throw new Error(`[JOB-CONTRACT-ERROR] jobId=${jobId || 'MISSING'} tenantId=${tenantId || 'MISSING'} Missing required identifiers for job type ${jobType || 'UNKNOWN'}.`);
        }

        // Job-specific contract validation
        if (jobType === 'AUTOFIX') {
            if (!input?.fileUrl && !payload?.filePath) {
                throw new Error(`[AUTOFIX-CONTRACT-ERROR] jobId=${jobId} Missing canonical file reference. Expected input.fileUrl (V2) or payload.filePath (legacy).`);
            }
        } else if (jobType === 'ANALYZE' || jobType === 'preflight_job') {
            if (!payload?.filePath && !input?.fileUrl) {
                throw new Error(`[ANALYZE-CONTRACT-ERROR] jobId=${jobId} Missing input file reference. Expected payload.filePath (legacy) or input.fileUrl (V2).`);
            }
        }

        const context = {
             jobId,
             tenantId,
             requestId,
             traceparent: trace.traceparent,
             policyProfile: policyProfile || data.policyProfile
        };

        // Phase 4: Full Telemetry (JOB_STARTED)
        await audit.log(context, {
             action: 'JOB_STARTED',
             resourceType: 'JOB',
             resourceId: jobId,
             status: 'PROCESSING'
        });

        logger.info({ requestId, route: job.name, tenantId, jobId, policyProfile }, 'Routing job through deterministic pipeline');

        // Isolation: Check if entity is quarantined (CircuitBreaker)
        const entityId = input?.assetId || payload?.assetId || jobId;
        if (CircuitBreaker.isOpen(entityId)) {
            await audit.log(context, {
                action: 'JOB_FAILED',
                error: 'QUARANTINE_ACTIVE',
                message: `Entity ${entityId} is in quarantine`
            });
            throw new Error(`CRITICAL: Entity ${entityId} is in QUARANTINE. Operation aborted.`);
        }

        const startTime = Date.now();
        try {
            let result;
            
            // Phase 3: Execute Preflight Pipeline
            switch (job.name) {
                case 'ANALYZE':
                case 'preflight_job': // Canonical name from shared-infra often
                    result = await AnalyzeProcessor.process(job, logger);
                    break;
                case 'AUTOFIX':
                    result = await AutofixProcessor.process(job, logger);
                    break;
                default:
                    throw new Error(`[JOB-ROUTER-ERROR] Unsupported job type: ${job?.name || 'UNKNOWN'}`);
            }

            const duration = Date.now() - startTime;

            // Phase 5: Immutable Execution Evidence (JOB_SUCCESS)
            // v2.4.90 Patch: Data loss prevention by preserving full result and mapping engine issues
            await audit.log(context, {
                 action: 'JOB_SUCCESS',
                 resourceType: 'JOB',
                 resourceId: jobId,
                 duration_ms: duration,
                 result: result, // Canonical result for BFF/APP contract alignment
                 evidence: {
                     input_hash: input?.fileUrl ? Buffer.from(input.fileUrl).toString('base64') : 'N/A',
                     policy_profile: policyProfile,
                     // Map engine outcome correctly (engine uses .issues or .findings, worker previously only checked .violations)
                     violations: (result.report?.violations || result.report?.issues || result.report?.findings || []),
                     artifacts: result.artifacts || {}
                 }
            });

            // Usage Metric Emission
            if (result.report?.document?.page_count) {
                await db.execute(
                    "INSERT INTO usage_events (tenant_id, job_id, metric, value, created_at) VALUES (?, ?, ?, ?, NOW())",
                    [tenantId, jobId, 'PREFLIGHT_PAGES', result.report.document.page_count]
                );
            }

            return result;

        } catch (err) {
            const duration = Date.now() - startTime;
            
            // Track failure for circuit breaker
            CircuitBreaker.recordFailure(entityId, err);
            
            // Phase 5: Failure Evidence
            await audit.log(context, {
                 action: 'JOB_FAILED',
                 error: err.code || 'INTERNAL_ERROR',
                 message: err.message,
                 duration_ms: duration,
                 stack: err.stack
            });

            throw err;
        }
    }
}

module.exports = JobRouter;
