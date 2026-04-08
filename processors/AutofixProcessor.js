/**
 * AutofixProcessor
 * 
 * Invokes the PrintPrice Engine for PDF correction.
 * Part of the Phase 3 Deterministic Execution Pipeline.
 * v2.4.89 - Contract & Telemetry Alignment
 */
const { createStandardEngine } = require('@ppos/preflight-engine');
const StorageManager = require('../utils/StorageManager');
const fs = require('fs-extra');

// Canonical storage instance
const storage = new StorageManager();

class AutofixProcessor {
    /**
     * Executes the Preflight Pipeline for Autofix/Repair.
     */
    static async process(job, logger = console) {
        // Phase 1 & 2: Unpack contract-governed envelope and resolve shape
        const data = job?.data || {};
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

        // Telemetry (v2.4.89)
        if (job.updateProgress) await job.updateProgress(10);

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

        if (job.updateProgress) await job.updateProgress(90);

        // Phase 5: Evidence Artifacts (Shape Unified for Phase 10)
        const artifacts = {
            fixed_file: result.fixedFilePath || `${outputDir}/normalized.pdf`,
            audit_report: `${outputDir}/fix_audit.json`
        };

        // v2.4.120: Certification Suffix Promotion (Autofix Processor)
        const certifiedPath = `${outputDir}/certified.pdf`;
        const bestSource = result.fixedFilePath || `${outputDir}/normalized.pdf`;
        if (await fs.pathExists(bestSource) && !(await fs.pathExists(certifiedPath))) {
            logger.info({ jobId, source: bestSource }, 'CERTIFY_FIX_PROMOTION_START');
            await fs.copy(bestSource, certifiedPath);
            logger.info({ jobId }, 'CERTIFY_FIX_PROMOTION_END');
        }

        // Verification of artifacts before returning
        const verifiedArtifacts = {};
        for (const [key, val] of Object.entries(artifacts)) {
            if (await fs.pathExists(val)) {
                verifiedArtifacts[key] = val;
            }
        }
        
        // Final canonical artifact registration
        if (await fs.pathExists(certifiedPath)) verifiedArtifacts.certified_pdf = 'certified.pdf';

        if (job.updateProgress) await job.updateProgress(100);

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
