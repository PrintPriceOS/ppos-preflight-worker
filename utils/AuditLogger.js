/**
 * AuditLogger
 * 
 * Generates immutable execution evidence and logs forensic-grade telemetry.
 * Stores evidence in MySQL (canonical job registry) and optionally Object Storage.
 */
const db = require('../../staged-libs/ppos-shared-infra/packages/data/db');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

class AuditLogger {
    constructor(mysqlPool) {
        this.db = mysqlPool || db;
    }

    /**
     * Produces forensic-grade telemetry and execution evidence.
     * 
     * @param {object} context { jobId, tenantId, requestId, ... }
     * @param {object} record Audit data { action, resourceType, resourceId, ... }
     */
    async log(context, record) {
        const entry = {
            id: `audit-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            timestamp: new Date().toISOString(),
            context: {
                jobId: context.jobId,
                tenantId: context.tenantId,
                requestId: context.requestId,
                deploymentId: context.deploymentId,
                serviceTier: context.serviceTier,
                traceparent: context.traceparent
            },
            ...record
        };

        // Emit structured log (Phase 4 Telemetry)
        logger.info({
            level: 'info',
            event: 'JOB_EXECUTION',
            ...entry,
            duration_ms: record.duration_ms,
            result: record.status || (record.action === 'JOB_SUCCESS' ? 'SUCCESS' : 'PENDING')
        }, `Audit Event: ${record.action}`);

        // Phase 5: Storage Layer - Split for reliability (preserving evidence vs status)
        try {
            // Store Forensic Evidence in database (Phase 5 Evidence & Audit)
            if (this.db) {
                await this.db.execute(
                    `INSERT INTO job_evidence (job_id, tenant_id, request_id, event_type, metadata, created_at)
                     VALUES (?, ?, ?, ?, ?, NOW())`,
                    [
                        context.jobId,
                        context.tenantId,
                        context.requestId,
                        record.action,
                        JSON.stringify(entry)
                    ]
                );
            }
        } catch (err) {
            logger.warn({ error: err.message, jobId: context.jobId }, 'Audit Layer: Failed to store evidence');
        }

        try {
            // Canonical Job State Registry Update (Harden for Phase 10)
            if (record.action.startsWith('JOB_') && this.db) {
                const statusMap = {
                    'JOB_STARTED': 'PROCESSING',
                    'JOB_SUCCESS': 'COMPLETED',
                    'JOB_FAILED': 'FAILED'
                };

                const dbStatus = statusMap[record.action];
                if (dbStatus) {
                    const progress = dbStatus === 'COMPLETED' ? 100 : (dbStatus === 'FAILED' ? 0 : 10);
                    const resultJson = record.result ? JSON.stringify(record.result) : (record.evidence ? JSON.stringify(record.evidence) : null);
                    const errorMsg = record.error ? `${record.error}: ${record.message}` : null;

                    await this.db.execute(
                        `UPDATE jobs 
                         SET status = ?, 
                             progress = ?, 
                             result = ?, 
                             error = ?, 
                             updated_at = NOW() 
                         WHERE id = ?`,
                        [dbStatus, progress, resultJson, errorMsg, context.jobId]
                    );
                }
            }
        } catch (err) {
            logger.error({ error: err.message, jobId: context.jobId }, 'Audit Layer: Failed to update job status');
        }
    }
}

module.exports = AuditLogger;
