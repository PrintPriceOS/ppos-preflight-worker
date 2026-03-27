/**
 * AuditLogger
 * 
 * Generates immutable execution evidence and logs forensic-grade telemetry.
 * Stores evidence in MySQL (canonical job registry) and optionally Object Storage.
 */
const { db } = require('@ppos/shared-infra');
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

        try {
            // Store Forensic Evidence in database (Phase 5 Evidence & Audit)
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

            // Canonical Job State Registry Update
            if (record.action.startsWith('JOB_')) {
                const statusMap = {
                    'JOB_STARTED': 'PROCESSING',
                    'JOB_SUCCESS': 'COMPLETED',
                    'JOB_FAILED': 'FAILED'
                };
                
                const dbStatus = statusMap[record.action];
                if (dbStatus) {
                    await this.db.execute(
                        "UPDATE jobs SET status = ?, updated_at = NOW() WHERE id = ?",
                        [dbStatus, context.jobId]
                    );
                }
            }

        } catch (err) {
            logger.warn({ error: err.message, jobId: context.jobId }, 'Audit Layer: Failed to store evidence');
        }
    }
}

module.exports = AuditLogger;
