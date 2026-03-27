/**
 * AutofixProcessor
 * 
 * Invokes the PrintPrice Engine for PDF correction.
 * Part of the Phase 3 Deterministic Execution Pipeline.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');
const StorageManager = require('../utils/StorageManager');

// Canonical storage instance
const storage = new StorageManager();

class AutofixProcessor {
    /**
     * Executes the Preflight Pipeline for Autofix/Repair.
     */
    static async process(data, logger = console) {
        // Phase 1 & 2: Unpack contract-governed envelope
        const { jobId, tenantId, input, policyProfile } = data;
        const { fileUrl, specs = {} } = input;
        
        if (!tenantId || !jobId) {
            throw new Error('[AUTOFIX-ERR] Missing tenantId or jobId. Isolation failure.');
        }

        // Phase 8: Isolation & Sandboxed Directories
        const outputDir = storage.getJobSubfolder(tenantId, jobId, 'output');
        const tempDir = storage.getJobSubfolder(tenantId, jobId, 'temp');

        logger.info({ 
            tenantId, 
            jobId, 
            policyProfile,
            fileUrl 
        }, 'Executing Preflight Pipeline: AUTOFIX');
        
        // 1. PDF Analysis & Repair (Engine)
        // 2. Artifact Generation (Engine)
        const engine = createStandardEngine();
        
        // Validation guided by external policyProfile
        const result = await engine.autofixPdf(fileUrl, {
            ...specs,
            policyProfile,
            outputDir,
            tempDir,
            tenantId
        });
        
        // Phase 5: Evidence Artifacts
        return {
            status: 'FIXED',
            result,
            tenantId,
            jobId,
            fixedAt: new Date().toISOString(),
            artifacts: {
                fixed_file: result.fixedFilePath || `${outputDir}/normalized.pdf`,
                audit_report: `${outputDir}/fix_audit.json`
            }
        };
    }
}

module.exports = AutofixProcessor;
