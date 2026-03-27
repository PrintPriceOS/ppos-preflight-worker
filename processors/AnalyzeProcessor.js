/**
 * AnalyzeProcessor
 * 
 * Invokes the PrintPrice Engine for PDF analysis.
 * Part of the Phase 3 Deterministic Execution Pipeline.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');
const StorageManager = require('../utils/StorageManager');

// Canonical storage instance
const storage = new StorageManager();

class AnalyzeProcessor {
    /**
     * Executes the Preflight Pipeline for Analysis.
     */
    static async process(data, logger = console) {
        // Phase 1 & 2: Unpack contract-governed envelope
        const { jobId, tenantId, input, policyProfile } = data;
        const { fileUrl, specs = {} } = input;
        
        if (!tenantId || !jobId) {
            throw new Error('[ANALYZE-ERR] Missing tenantId or jobId. Isolation failure.');
        }

        // Phase 8: Isolation & Sandboxed Directories
        const outputDir = storage.getJobSubfolder(tenantId, jobId, 'output');
        const tempDir = storage.getJobSubfolder(tenantId, jobId, 'temp');

        logger.info({ 
            tenantId, 
            jobId, 
            policyProfile,
            fileUrl 
        }, 'Executing Preflight Pipeline: ANALYZE');
        
        // 1. PDF Analysis (Poppler/Engine)
        // 2. Rendering / Normalization (Ghostscript/Engine)
        const engine = createStandardEngine();
        
        // NOTE: In Phase 3, we don't hardcode rules.
        // All validation comes from policyEngine.evaluate(report, policyProfile)
        // For now, these are passed as 'options' to the engine.
        const report = await engine.analyzePdf(fileUrl, {
            ...specs,
            policyProfile,
            outputDir,
            tempDir,
            tenantId
        });
        
        // Phase 5: Evidence Artifacts
        return {
            status: 'COMPLETED',
            report,
            tenantId,
            jobId,
            processedAt: new Date().toISOString(),
            artifacts: {
                report_json: `${outputDir}/report.json`,
                previews: `${outputDir}/previews/`
            }
        };
    }
}

module.exports = AnalyzeProcessor;
