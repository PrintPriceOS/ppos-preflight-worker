const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Contract-Aware StorageManager (Worker side)
 * mirrors service implementation to ensure isolation consistency.
 */
class StorageManager {
    constructor(basePath = process.env.PPOS_UPLOADS_DIR || '/storage') {
        this.basePath = basePath;
    }

    getJobPath(tenantId, jobId) {
        if (!tenantId || !jobId) {
            throw new Error('[STORAGE-ERR] tenantId and jobId are REQUIRED for isolation.');
        }
        return path.join(this.basePath, 'tenants', tenantId, 'jobs', jobId);
    }

    getJobSubfolder(tenantId, jobId, subfolder) {
        const allowed = ['input', 'output', 'temp', 'reports'];
        if (!allowed.includes(subfolder)) {
            throw new Error(`[STORAGE-ERR] Invalid subfolder requested: ${subfolder}`);
        }
        return path.join(this.getJobPath(tenantId, jobId), subfolder);
    }

    /**
     * Prepares isolated storage for a job based on deployment context.
     */
    async initializeJobStorage(context, jobId) {
        const { tenantId, deploymentId, tenantIsolation } = context;
        const base = this.getJobPath(tenantId, jobId);

        try {
            await fs.ensureDir(path.join(base, 'input'));
            await fs.ensureDir(path.join(base, 'output'));
            await fs.ensureDir(path.join(base, 'temp'));
            await fs.ensureDir(path.join(base, 'reports'));
            
            if (tenantIsolation === 'cluster') {
                 await fs.ensureDir(path.join(base, '.cluster-metadata'));
            }

            return base;
        } catch (err) {
            throw err;
        }
    }

    verifyPathIsolation(tenantId, targetPath) {
        const tenantRoot = path.join(this.basePath, 'tenants', tenantId);
        const resolvedPath = path.resolve(targetPath);
        if (!resolvedPath.startsWith(tenantRoot)) {
            throw new Error(`CRITICAL: Isolation breach detected for tenant ${tenantId}.`);
        }
        return true;
    }
}

module.exports = StorageManager;
