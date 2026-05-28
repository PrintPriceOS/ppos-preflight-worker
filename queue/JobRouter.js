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
                    violations: (result.report?.violations || result.report?.issues || result.report?.findings || []),
                    artifacts: result.artifacts || {}
                }
            });

            // Usage Metric Emission
            if (result.report?.document?.page_count) {
                try {
                    await db.execute(
                        "INSERT INTO usage_events (tenant_id, job_id, metric, value, created_at) VALUES (?, ?, ?, ?, NOW())",
                        [tenantId, jobId, 'PREFLIGHT_PAGES', result.report.document.page_count]
                    );
                } catch (metricErr) {
                    logger.warn({ jobId, error: metricErr.message }, '[WORKER][METRIC][WARN] Failed to write usage metric');
                }
            }

            // Direct DB persistence of rich result
            if (db && typeof db.execute === 'function') {
                try {
                    const dbStatus = (result.status || 'COMPLETED').substring(0, 30);
                    const dbResultJson = JSON.stringify(result);
                    await db.execute(
                        "UPDATE jobs SET status = ?, result = ?, error = NULL, progress = 100, updated_at = NOW() WHERE id = ? AND tenant_id = ?",
                        [dbStatus, dbResultJson, jobId, tenantId]
                    );
                    logger.info({ jobId, dbStatus }, '[WORKER][DATABASE][SUCCESS] Successfully persisted final job state');
                } catch (dbErr) {
                    logger.warn({ jobId, error: dbErr.message }, '[WORKER][DATABASE][WARN] Failed to persist job success result to database');
                }
            }

            // Phase 6: Sync to Control Plane Preflight Registry
            try {
                const ControlPlaneJobSync = require('../utils/ControlPlaneJobSync');
                const os = require('os');
                const syncClient = new ControlPlaneJobSync({
                    url: process.env.CONTROL_PLANE_URL,
                    token: process.env.PPOS_CONTROL_TOKEN,
                    workerId: process.env.WORKER_ID || `worker-${os.hostname()}`
                }, logger);

                // Prepare final payload based on prompt spec
                const isAnalyze = jobType === 'ANALYZE' || jobType === 'preflight_job';
                const isAutofix = jobType === 'AUTOFIX';
                
                const findings = result.findings || (result.report && result.report.findings) || [];
                const findingsCount = Array.isArray(findings) ? findings.length : 0;
                const issues = result.issues || (result.report && result.report.issues) || [];
                const issuesCount = Array.isArray(issues) ? issues.length : 0;

                const requestedFixes = result.requested_fixes || [];
                const appliedFixes = result.applied_fixes || [];
                const skippedFixes = result.skipped_fixes || [];
                const failedFixes = result.failed_fixes || [];

                let productionCertified = null;
                let requiresHumanReview = null;
                const reviewReasons = [];

                if (isAnalyze) {
                    // Check if certification is true
                    const hasBlockingFindings = findings.some(f => {
                        const sev = (f.severity || '').toLowerCase();
                        return sev === 'critical' || sev === 'error';
                    });
                    
                    const classifier = result.status; // AnalyzeProcessor returns status mapped from classifier
                    
                    if (classifier !== 'FAILED' && classifier !== 'DOCUMENT_FAILURE' && !hasBlockingFindings) {
                        // Look at analysisIntegrity
                        if (result.analysisIntegrity && result.analysisIntegrity.certifiable !== false) {
                            productionCertified = true;
                        }
                    }
                    if (productionCertified === null) productionCertified = false;
                    requiresHumanReview = findingsCount > 0 && !productionCertified;
                } else if (isAutofix) {
                    if (failedFixes.length > 0) {
                        requiresHumanReview = true;
                        reviewReasons.push('Some fixes failed to apply');
                    }
                    if (skippedFixes.length > 0) {
                        requiresHumanReview = true;
                        reviewReasons.push('Some fixes were skipped');
                    }
                    if (appliedFixes.length > 0 && failedFixes.length === 0 && skippedFixes.length === 0) {
                        productionCertified = true;
                    } else {
                        productionCertified = false;
                    }
                }

                const syncPayload = {
                    jobId,
                    sourceJobId: result.sourceJobId || data.sourceJobId || null,
                    tenantId,
                    type: jobType === 'preflight_job' ? 'ANALYZE' : jobType,
                    status: result.status,
                    source_status: data.status || result.status, // Whatever status was passed down initially
                    final_status: result.status,
                    findingsCount,
                    issuesCount,
                    requestedFixesCount: requestedFixes.length,
                    appliedFixesCount: appliedFixes.length,
                    skippedFixesCount: skippedFixes.length,
                    failedFixesCount: failedFixes.length,
                    productionCertified,
                    requiresHumanReview,
                    reviewReasons,
                    artifacts: result.artifacts || {},
                    analysisIntegrity: result.analysisIntegrity || {},
                    updatedAt: result.processedAt || new Date().toISOString()
                };

                await syncClient.syncJobResult(syncPayload);
            } catch (syncErr) {
                logger.warn({ jobId, error: syncErr.message }, '[WORKER][CONTROL-PLANE-JOB-SYNC][ERROR] Unhandled error preparing sync');
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

            // Direct DB persistence of job failure
            if (db && typeof db.execute === 'function') {
                try {
                    const failResult = {
                        status: 'FAILED',
                        type: jobType,
                        error: err.message,
                        code: err.code || 'INTERNAL_ERROR',
                        stack: err.stack,
                        tenantId,
                        jobId,
                        processedAt: new Date().toISOString()
                    };
                    await db.execute(
                        "UPDATE jobs SET status = 'FAILED', error = ?, result = ?, progress = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?",
                        [err.message, JSON.stringify(failResult), job?.progress || 100, jobId, tenantId]
                    );
                    logger.info({ jobId }, '[WORKER][DATABASE][SUCCESS] Successfully persisted job failure state');
                } catch (dbErr) {
                    logger.warn({ jobId, error: dbErr.message }, '[WORKER][DATABASE][WARN] Failed to persist job failure to database');
                }
            }

            throw err;
        }
    }
}

module.exports = JobRouter;
