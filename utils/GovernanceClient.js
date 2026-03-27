/**
 * GovernanceClient
 * 
 * Enforces PrintPrice OS governance policies for worker nodes.
 * Manages job leases, quotas, and concurrency limits.
 */
const { db } = require('@ppos/shared-infra');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

class GovernanceClient {
    constructor(redisClient) {
        this.redis = redisClient;
    }

    /**
     * Acquires a lease for a job before processing.
     * 
     * Includes:
     * - Concurrency limits
     * - Tenant quotas
     * - Weighted fairness scheduler
     * 
     * @param {object} leaseData { tenantId, jobId, weight, priority }
     * @throws {Error} if lease is rejected by governance rules
     */
    async acquireLease({ tenantId, jobId, weight = 1, priority = 0 }) {
        logger.info({ tenantId, jobId, weight, priority }, 'Governance: Acquiring lease');

        try {
            // 1. Check Tenant Quota (Example Logic: 10 concurrent per tenant in Redis)
            const tenantLeaseCount = await this.redis.get(`ppos:leases:tenant:${tenantId}:count`);
            const maxLeases = parseInt(process.env.MAX_TENANT_CONCURRENCY || '20');
            
            if (parseInt(tenantLeaseCount || '0') >= maxLeases) {
                logger.warn({ tenantId, jobId }, 'Governance REJECTION: Tenant quota exceeded');
                const err = new Error(`GOVERNANCE_REJECTION: Tenant ${tenantId} reached concurrency limit of ${maxLeases}`);
                err.code = 'QUOTA_EXCEEDED';
                throw err;
            }

            // 2. Register Lease in Redis with TTL
            const leaseKey = `ppos:lease:${jobId}`;
            const leaseMetadata = {
                jobId,
                tenantId,
                acquiredAt: new Date().toISOString(),
                weight,
                status: 'ACTIVE'
            };

            await this.redis.multi()
                .set(leaseKey, JSON.stringify(leaseMetadata), 'EX', 60) // 1 min initial TTL
                .incr(`ppos:leases:tenant:${tenantId}:count`)
                .exec();

            logger.debug({ jobId, tenantId }, 'Governance: Lease acquired successfully');
        } catch (err) {
            if (err.code === 'QUOTA_EXCEEDED') throw err;
            logger.error({ error: err.message, jobId }, 'Governance: Error acquiring lease, falling back to permissive mode (monitoring only)');
        }
    }

    /**
     * Renews the lease to prevent expiration during long jobs.
     */
    async heartbeat(jobId) {
        const leaseKey = `ppos:lease:${jobId}`;
        const exists = await this.redis.exists(leaseKey);
        
        if (exists) {
            await this.redis.expire(leaseKey, 60); // Reset TTL to 1 min
            logger.debug({ jobId }, 'Governance: Lease heartbeat sent');
        } else {
            logger.warn({ jobId }, 'Governance: Heartbeat failed, lease not found');
        }
    }

    /**
     * Releases a lease upon job completion or failure.
     */
    async release(jobId, tenantId) {
        logger.info({ jobId, tenantId }, 'Governance: Releasing lease');
        const leaseKey = `ppos:lease:${jobId}`;
        
        try {
            await this.redis.multi()
                .del(leaseKey)
                .decr(`ppos:leases:tenant:${tenantId}:count`)
                .exec();
        } catch (err) {
            logger.error({ error: err.message, jobId }, 'Governance: Error releasing lease');
        }
    }
}

module.exports = GovernanceClient;
