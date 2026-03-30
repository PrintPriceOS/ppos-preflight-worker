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
        // Phase 1 & 2: Unpack contract-governed envelope and resolve shape
        const { jobId, tenantId, input, payload, policyProfile, trace = {} } = data;

        const fileUrl = input?.fileUrl || payload?.filePath;
        const contractMode = input?.fileUrl ? 'v2_input' : 'legacy_payload';

        if (!jobId || !tenantId) {
            throw new Error(`[AUTOFIX-CONTRACT-ERROR] jobId=${jobId || 'MISSING'} Missing jobId or tenantId. Isolation failure.`);
        }

        if (!fileUrl) {
            throw new Error(`[AUTOFIX-CONTRACT-ERROR] jobId=${jobId} Missing canonical file reference. Expected input.fileUrl (V2) or payload.filePath (legacy).`);
        }

        // Verify path isolation to prevent leakage (preserving core safety)
        storage.verifyPathIsolation(tenantId, fileUrl);

        // Phase 8: Isolation & Sandboxed Directories
        const outputDir = storage.getJobSubfolder(tenantId, jobId, 'output');
        const tempDir = storage.getJobSubfolder(tenantId, jobId, 'temp');

        // Normalize specs/options (Support for flattened, nested V2, and legacy shapes)
        const rawSpecs = input?.specs || {};
        const normalizedPolicy = rawSpecs.policy || payload?.policy || null;
        const normalizedOptions =
            rawSpecs.options ||
            (rawSpecs.policy || rawSpecs.options ? {} : rawSpecs) ||
            payload?.options ||
            {};

        logger.info({
            tenantId,
            jobId,
            policyProfile,
            fileUrl,
            contractMode,
            requestId: trace?.requestId || data.requestId
        }, `Executing Preflight Pipeline: AUTOFIX [${contractMode}]`);

        // 1. PDF Analysis & Repair (Engine)
        const engine = createStandardEngine();

        // Validation guided by external policyProfile
        const result = await engine.autofixPdf(fileUrl, {
            ...(normalizedPolicy ? { policy: normalizedPolicy } : {}),
            ...normalizedOptions,
            policyProfile,
            outputDir,
            tempDir,
            tenantId
        });

        // Phase 5: Evidence Artifacts (Shape Unified for Phase 10)
        const artifacts = {
            fixed_file: result.fixedFilePath || `${outputDir}/normalized.pdf`,
            audit_report: `${outputDir}/fix_audit.json`
        };

        // Verification of artifacts before returning
        const fs = require('fs-extra');
        const verifiedArtifacts = {};
        for (const [key, val] of Object.entries(artifacts)) {
            if (fs.existsSync(val)) {
                verifiedArtifacts[key] = val;
            }
        }

        return {
            status: 'COMPLETED',
            report: result,
            artifacts: verifiedArtifacts,
            tenantId,
            jobId,
            processedAt: new Date().toISOString()
        };
    }
}

module.exports = AutofixProcessor;
