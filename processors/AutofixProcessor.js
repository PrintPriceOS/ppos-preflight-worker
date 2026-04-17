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
const path = require('path');

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

        if (!path.isAbsolute(fileUrl)) {
            throw new Error(`INPUT_FILE_NOT_FOUND: jobId=${jobId} fileUrl is a relative path and cannot be resolved: "${fileUrl}". The originating service must store absolute paths.`);
        }

        if (!(await fs.pathExists(fileUrl))) {
            throw new Error(`INPUT_FILE_NOT_FOUND: jobId=${jobId} Input file not found at path: "${fileUrl}"`);
        }

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

        if (result.ok === false) {
            throw new Error(`[AUTOFIX-ENGINE-ERROR] jobId=${jobId} Engine failed: ${result.error}`);
        }

        if (job.updateProgress) await job.updateProgress(90);

        // Phase 5: Evidence Artifacts (Shape Unified for Phase 10)
        logger.info({ jobId, outputDir }, '[WORKER][AUTOFIX][SEARCHING-ARTIFACTS]');

        let bestSource = null;

        // 1. Priority: Explicit fixedPath
        if (result.fixedPath) {
            logger.info({ jobId, path: result.fixedPath }, '[WORKER][AUTOFIX][ENGINE-FIXED-PATH]');
            if (await fs.pathExists(result.fixedPath)) {
                bestSource = result.fixedPath;
            }
        }

        // 2. Priority: Structured artifacts path
        if (!bestSource && result.artifacts?.fixed_pdf?.path) {
            const artifactPath = result.artifacts.fixed_pdf.path;
            logger.info({ jobId, path: artifactPath }, '[WORKER][AUTOFIX][ENGINE-ARTIFACT-PATH]');
            if (await fs.pathExists(artifactPath)) {
                bestSource = artifactPath;
            }
        }

        // 3. Fallback: Legacy path guesses (e.g., normalized.pdf)
        if (!bestSource) {
            const legacyPath = `${outputDir}/normalized.pdf`;
            logger.info({ jobId, path: legacyPath }, '[WORKER][AUTOFIX][LEGACY-FALLBACK]');
            if (await fs.pathExists(legacyPath)) {
                bestSource = legacyPath;
            }
        }

        const certifiedPath = `${outputDir}/certified.pdf`;
        const fixedPdfPath = `${outputDir}/fixed.pdf`;
        const verifiedArtifacts = {};

        if (bestSource) {
            // v2.4.120: Certification Suffix Promotion
            // Promote bestSource to canonical filenames (ensuring fresh copies for this execution)
            if (bestSource !== certifiedPath) {
                await fs.copy(bestSource, certifiedPath, { overwrite: true });
            }
            if (bestSource !== fixedPdfPath) {
                await fs.copy(bestSource, fixedPdfPath, { overwrite: true });
            }

            verifiedArtifacts.certified_pdf = 'certified.pdf';
            verifiedArtifacts.fixed_pdf = 'fixed.pdf';

            logger.info({ jobId, artifact: 'certified_pdf' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
            logger.info({ jobId, artifact: 'fixed_pdf' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
        }

        // Optional: register audit report if it exists
        const auditReportPath = `${outputDir}/fix_audit.json`;
        if (await fs.pathExists(auditReportPath)) {
            verifiedArtifacts.audit_report = 'fix_audit.json';
            logger.info({ jobId, artifact: 'audit_report' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
        }

        if (Object.keys(verifiedArtifacts).length === 0) {
            logger.error({ jobId }, '[WORKER][AUTOFIX][NO-OUTPUT]');
            throw new Error(`[AUTOFIX-FAILURE] jobId=${jobId} Engine reported success but no valid output file found.`);
        }

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
