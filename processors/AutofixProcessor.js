/**
 * AutofixProcessor
 * 
 * Invokes the Engine for PDF fixes.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');

const StorageManager = require('../utils/StorageManager');
const storage = new StorageManager();

class AutofixProcessor {
    static async process(data, logger = console) {
        // Phase 2: Unpack envelope and enforce isolation
        const { jobId, tenantId, deploymentId, tenantIsolation, payload } = data;
        const { filePath, policy, options } = payload;
        
        if (!tenantId || !jobId) {
            throw new Error('[AUTOFIX-ERR] Missing tenantId or jobId for isolation.');
        }

        // Verify path isolation
        storage.verifyPathIsolation(tenantId, filePath);

        const outputDir = storage.getJobSubfolder(tenantId, jobId, 'output');
        const reportsDir = storage.getJobSubfolder(tenantId, jobId, 'reports');

        logger.info({ 
            tenantId, 
            jobId, 
            deploymentId, 
            tenantIsolation,
            filePath 
        }, 'Running engine autofix in contract-governed context');
        
        const engine = createStandardEngine();
        const result = await engine.autofixPdf(filePath, policy, {
            ...options,
            outputDir,
            reportsDir,
            tenantId
        });
        
        return {
            status: 'FIXED',
            result,
            tenantId,
            jobId,
            fixedAt: new Date().toISOString()
        };
    }
}

module.exports = AutofixProcessor;
