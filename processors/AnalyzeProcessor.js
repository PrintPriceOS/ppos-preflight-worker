/**
 * AnalyzeProcessor
 * 
 * Invokes the Engine for PDF analysis.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');

const StorageManager = require('../utils/StorageManager');
const storage = new StorageManager();

class AnalyzeProcessor {
    static async process(data, logger = console) {
        // Phase 2: Unpack envelope and enforce isolation
        const { jobId, tenantId, deploymentId, tenantIsolation, payload } = data;
        const { filePath, options } = payload;
        
        if (!tenantId || !jobId) {
            throw new Error('[ANALYZE-ERR] Missing tenantId or jobId. Isolation failure.');
        }

        // Verify path isolation to prevent leakage
        storage.verifyPathIsolation(tenantId, filePath);

        const outputDir = storage.getJobSubfolder(tenantId, jobId, 'output');
        const tempDir = storage.getJobSubfolder(tenantId, jobId, 'temp');

        logger.info({ 
            tenantId, 
            jobId, 
            deploymentId, 
            tenantIsolation,
            filePath 
        }, 'Running engine analyze in contract-governed context');
        
        const engine = createStandardEngine();
        const report = await engine.analyzePdf(filePath, {
            ...options,
            outputDir,
            tempDir,
            tenantId
        });
        
        return {
            status: 'COMPLETED',
            report,
            tenantId,
            jobId,
            processedAt: new Date().toISOString()
        };
    }
}

module.exports = AnalyzeProcessor;
