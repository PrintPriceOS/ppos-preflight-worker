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
        // Phase 2: Unpack envelope and resolve contract shape
        const { jobId, tenantId, deploymentId, tenantIsolation, payload, input, trace = {} } = data;
        
        const filePath = payload?.filePath || input?.fileUrl;
        const contractMode = payload?.filePath ? 'legacy_payload' : 'v2_input';

        if (!jobId || !tenantId) {
            throw new Error(`[ANALYZE-CONTRACT-ERROR] jobId=${jobId || 'MISSING'} Missing jobId or tenantId. Isolation failure.`);
        }

        if (!filePath) {
            throw new Error(`[ANALYZE-CONTRACT-ERROR] jobId=${jobId} Missing input file reference. Expected payload.filePath (legacy) or input.fileUrl (V2).`);
        }

        // Verify path isolation to prevent leakage (preserving core safety)
        storage.verifyPathIsolation(tenantId, filePath);

        const outputDir = storage.getJobSubfolder(tenantId, jobId, 'output');
        const tempDir = storage.getJobSubfolder(tenantId, jobId, 'temp');

        const options = payload?.options || input?.specs?.options || {};

        logger.info({ 
            tenantId, 
            jobId, 
            deploymentId, 
            tenantIsolation,
            filePath,
            contractMode,
            requestId: trace?.requestId || data.requestId
        }, `Running engine analyze: [${contractMode}]`);
        
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
            artifacts: {},
            tenantId,
            jobId,
            processedAt: new Date().toISOString()
        };
    }
}

module.exports = AnalyzeProcessor;
