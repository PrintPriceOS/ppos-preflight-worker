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
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const ControlPlaneArtifacts = require('../utils/ControlPlaneArtifacts');
const os = require('os');
const { sha256File } = require('../utils/fileChecksum');

// Canonical storage instance
const storage = new StorageManager();

/**
 * Derives a concrete fixPlan from the policy name and incoming options.
 * PreflightEngine requires an explicit type/target; without one it falls
 * back to copying the input unchanged ("Copied" note).
 */
function resolveFixPlan(policy, options = {}) {
    if (options.type || options.target || options.forceBleed) return options;

    // Offset / coated / uncoated profiles always require CMYK output
    const isCmykPolicy = /offset|coated|uncoated|iso|pso|cmyk/i.test(policy || '');
    if (isCmykPolicy) {
        return { ...options, target: 'cmyk' };
    }

    return { ...options, target: 'cmyk' };
}

class AutofixProcessor {
    /**
     * Attempts to repair structural PDF defects using qpdf before Ghostscript.
     * Prevents Ghostscript "circular reference" failures on LuaTeX PDFs.
     */
    static async sanitizePdfForAutofix(inputPath, tempDir, logger, context = {}) {
        const { jobId, tenantId } = context;
        const sanitizedPath = path.join(tempDir, 'sanitized_input.pdf');

        logger.info({ jobId, tenantId, inputPath, sanitizedPath }, '[WORKER][AUTOFIX][SANITIZE-START]');

        try {
            // Using qpdf for structural repair.
            // This fixes "circular reference to indirect object" common in LuaTeX files.
            // Note: qpdf returns exit code 3 if it fixes warnings/errors successfully.
            await execPromise(`qpdf "${inputPath}" "${sanitizedPath}"`);
            
            logger.info({ jobId, sanitizedPath }, '[WORKER][AUTOFIX][SANITIZE-SUCCESS]');
            return sanitizedPath;
        } catch (error) {
            // Exit code 3 means qpdf encountered issues but repaired them and produced output.
            if (error.code === 3 && await fs.pathExists(sanitizedPath)) {
                logger.info({ jobId, sanitizedPath }, '[WORKER][AUTOFIX][SANITIZE-SUCCESS] (repaired with warnings)');
                return sanitizedPath;
            }

            logger.warn({ 
                jobId, 
                error: error.message,
                errorCode: error.code,
                originalInput: inputPath 
            }, '[WORKER][AUTOFIX][SANITIZE-FAIL] Repair attempt failed. Proceeding with original file.');
            
            // Fallback to original input if qpdf fails
            return inputPath;
        }
    }

    /**
     * Executes the Preflight Pipeline for Autofix/Repair.
     */
    static async process(job, logger = console) {
        // Phase 1 & 2: Unpack contract-governed envelope and resolve shape
        const data = job?.data || {};
        const { jobId, tenantId, input, payload, policyProfile, trace = {} } = data;

        if (jobId && tenantId) {
            logger.info({ jobId, tenantId }, '[PREFLIGHT-WORKER][AUTOFIX_START]');
        }

        const fileUrl = input?.fileUrl || payload?.filePath;
        const contractMode = input?.fileUrl ? 'v2_input' : 'legacy_payload';

        if (!jobId || !tenantId) {
            throw new Error(`[AUTOFIX-CONTRACT-ERROR] jobId=${jobId || 'MISSING'} Missing jobId or tenantId. Isolation failure.`);
        }

        if (!fileUrl) {
            throw new Error(`[AUTOFIX-CONTRACT-ERROR] jobId=${jobId} Missing canonical file reference. Expected input.fileUrl (V2) or payload.filePath (legacy).`);
        }

        if (!path.isAbsolute(fileUrl)) {
            throw new Error(`SOURCE_PDF_NOT_FOUND: jobId=${jobId} fileUrl is a relative path and cannot be resolved: "${fileUrl}". The originating service must store absolute paths.`);
        }

        if (!(await fs.pathExists(fileUrl))) {
            throw new Error(`SOURCE_PDF_NOT_FOUND: jobId=${jobId} Input file not found at path: "${fileUrl}"`);
        }
        
        logger.info({ jobId, tenantId, fileUrl }, '[PREFLIGHT-WORKER][SOURCE_PDF_RESOLVED]');

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

        // Extract requested fixes robustly across all potential envelope levels
        let rawFixes = data.fixes || input?.fixes || rawSpecs?.fixes || payload?.fixes;
        let requestedFixes = [];
        if (Array.isArray(rawFixes)) {
            requestedFixes = [...rawFixes];
        } else if (typeof rawFixes === 'string') {
            requestedFixes = [rawFixes];
        }

        if (requestedFixes.length === 0) {
            const rf = data.requested_fixes || input?.requested_fixes || rawSpecs?.requested_fixes || payload?.requested_fixes ||
                       data.requestedFixes || input?.requestedFixes || rawSpecs?.requestedFixes || payload?.requestedFixes;
            if (Array.isArray(rf)) requestedFixes = [...rf];
            else if (typeof rf === 'string') requestedFixes = [rf];
        }

        let forceBleed = data.forceBleed ?? input?.forceBleed ?? rawSpecs?.forceBleed ?? payload?.forceBleed ?? normalizedOptions?.forceBleed ?? false;
        let targetProfile = data.targetProfile ?? input?.targetProfile ?? rawSpecs?.targetProfile ?? payload?.targetProfile ?? normalizedOptions?.targetProfile ?? null;
        let sourceJobId = data.sourceJobId ?? input?.sourceJobId ?? rawSpecs?.sourceJobId ?? payload?.sourceJobId ?? null;

        // Resolve source findings
        let sourceFindings = null;
        const inlineFindings = data.findings || input?.findings || rawSpecs?.findings || payload?.findings ||
                               data.issues || input?.issues || rawSpecs?.issues || payload?.issues ||
                               data.violations || input?.violations || rawSpecs?.violations || payload?.violations;
        if (Array.isArray(inlineFindings)) {
            sourceFindings = inlineFindings;
        }

        if (!sourceFindings && sourceJobId) {
            try {
                const possibleDirs = [
                    storage.getJobSubfolder(tenantId, sourceJobId, 'reports'),
                    storage.getJobSubfolder(tenantId, sourceJobId, 'output')
                ];
                const possibleFiles = ['analysis_report.json', 'report.json', 'result.json', 'findings.json'];
                for (const dir of possibleDirs) {
                    for (const file of possibleFiles) {
                        const fullPath = path.join(dir, file);
                        if (await fs.pathExists(fullPath)) {
                            try {
                                const content = await fs.readJson(fullPath);
                                const found = content?.findings || content?.issues || content?.violations ||
                                              content?.report?.findings || content?.report?.issues || content?.report?.violations;
                                if (Array.isArray(found)) {
                                    sourceFindings = found;
                                    logger.info({ sourceJobId, file: fullPath }, '[WORKER][AUTOFIX][SOURCE-FINDINGS-DISK] Loaded source findings from disk');
                                    break;
                                }
                            } catch (e) {
                                // ignore
                            }
                        }
                    }
                    if (sourceFindings) break;
                }

                if (!sourceFindings) {
                    try {
                        const db = require('@ppos/shared-infra/packages/data/db');
                        if (db && typeof db.execute === 'function') {
                            const dbRes = await db.execute('SELECT result FROM jobs WHERE id = ? AND tenant_id = ?', [sourceJobId, tenantId]);
                            const rows = Array.isArray(dbRes) ? (Array.isArray(dbRes[0]) ? dbRes[0] : dbRes) : [];
                            if (rows && rows.length > 0 && rows[0].result) {
                                let parsed = null;
                                if (typeof rows[0].result === 'string') parsed = JSON.parse(rows[0].result);
                                else if (typeof rows[0].result === 'object') parsed = rows[0].result;
                                const found = parsed?.findings || parsed?.issues || parsed?.violations ||
                                              parsed?.report?.findings || parsed?.report?.issues || parsed?.report?.violations;
                                if (Array.isArray(found)) {
                                    sourceFindings = found;
                                    logger.info({ sourceJobId }, '[WORKER][AUTOFIX][SOURCE-FINDINGS-DB] Loaded source findings from database');
                                }
                            }
                        }
                    } catch (dbErr) {
                        logger.warn({ error: dbErr.message }, '[WORKER][AUTOFIX][SOURCE-FINDINGS-DB-ERR] Could not load from DB');
                    }
                }
            } catch (err) {
                logger.warn({ error: err.message }, '[WORKER][AUTOFIX][SOURCE-FINDINGS-ERR] Error retrieving source findings');
            }
        }

        const hasSourceFindings = sourceFindings && sourceFindings.length > 0;

        // Instrumentation 1: [WORKER][AUTOFIX][PAYLOAD-IN]
        logger.info({
            jobId,
            fixJobId: jobId,
            sourceJobId,
            requestedFixesCount: requestedFixes.length,
            requestedFixes,
            sourceFindingsCount: sourceFindings ? sourceFindings.length : 0,
            engineRepairsCount: 0,
            engineRepairs: [],
            storedRepairsCount: 0,
            storedRepairs: [],
            artifacts: [],
            artifactNames: {},
            forceBleed,
            targetProfile
        }, '[WORKER][AUTOFIX][PAYLOAD-IN] Incoming autofix job payload received');

        // Instrumentation 2: [WORKER][AUTOFIX][SOURCE-FINDINGS]
        if (!hasSourceFindings) {
            logger.warn({
                jobId,
                fixJobId: jobId,
                sourceJobId,
                requestedFixesCount: requestedFixes.length,
                requestedFixes,
                sourceFindingsCount: 0,
                engineRepairsCount: 0,
                engineRepairs: [],
                storedRepairsCount: 0,
                storedRepairs: [],
                artifacts: [],
                artifactNames: {},
                reason: 'MISSING_SOURCE_FINDINGS_FOR_AUTOFIX',
                forceBleed,
                targetProfile
            }, '[WORKER][AUTOFIX][SOURCE-FINDINGS] MISSING_SOURCE_FINDINGS_FOR_AUTOFIX: No source findings available for autofix');
        } else {
            logger.info({
                jobId,
                fixJobId: jobId,
                sourceJobId,
                requestedFixesCount: requestedFixes.length,
                requestedFixes,
                sourceFindingsCount: sourceFindings.length,
                engineRepairsCount: 0,
                engineRepairs: [],
                storedRepairsCount: 0,
                storedRepairs: [],
                artifacts: [],
                artifactNames: {},
                forceBleed,
                targetProfile
            }, '[WORKER][AUTOFIX][SOURCE-FINDINGS] Source findings successfully resolved');
        }

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

        // Phase 9: Pre-repair/Sanitization Stage (v2.5.0)
        // Fix for "circular reference to indirect object" in malformed PDFs
        const sanitizedInput = await this.sanitizePdfForAutofix(fileUrl, tempDir, logger, { jobId, tenantId });

        // Derive a concrete fix target from the policy so PreflightEngine
        // doesn't fall back to the no-op copy path (missing type/target).
        const fixPlan = resolveFixPlan(normalizedPolicy, {
            ...normalizedOptions,
            forceBleed,
            targetProfile,
            fixes: requestedFixes,
            requested_fixes: requestedFixes
        });

        logger.info({ jobId, fixPlan, policy: normalizedPolicy, sanitized: sanitizedInput !== fileUrl }, '[WORKER][AUTOFIX][FIX-PLAN-RESOLVED]');

        const enginePayload = {
            ...(normalizedPolicy ? { policy: normalizedPolicy } : {}),
            ...fixPlan,
            policyProfile,
            outputDir,
            tempDir,
            tenantId,
            // Guaranteed forwarded context:
            sourceJobId: sourceJobId || null,
            requested_fixes: requestedFixes,
            fixes: requestedFixes,
            forceBleed,
            targetProfile,
            findings: sourceFindings || []
        };

        // Instrumentation 3: [WORKER][AUTOFIX][ENGINE-CALL]
        logger.info({
            jobId,
            fixJobId: jobId,
            sourceJobId,
            requestedFixesCount: requestedFixes.length,
            requestedFixes,
            sourceFindingsCount: sourceFindings ? sourceFindings.length : 0,
            engineRepairsCount: 0,
            engineRepairs: [],
            storedRepairsCount: 0,
            storedRepairs: [],
            artifacts: [],
            artifactNames: {},
            forceBleed,
            targetProfile
        }, '[WORKER][AUTOFIX][ENGINE-CALL] Invoking engine.autofixPdf with preserved intent');

        const result = await engine.autofixPdf(sanitizedInput, enginePayload);

        // Extract repairs to ensure complete preservation
        const allRepairs = Array.isArray(result?.repairs) ? result.repairs : (Array.isArray(result?.fixes) ? result.fixes : []);
        
        let appliedFixes = result?.applied_fixes || [];
        let skippedFixes = result?.skipped_fixes || [];
        let failedFixes = result?.failed_fixes || [];
        const fixResults = result?.fix_results || [];
        const reviewRequired = result?.review_required || false;
        const reviewRequiredReasons = result?.review_required_reasons || [];
        let productionCertified = result?.production_certified || false;
        
        if (!appliedFixes.length && !skippedFixes.length && !failedFixes.length && allRepairs.length) {
            appliedFixes = allRepairs.filter(r => r?.status === 'APPLIED');
            skippedFixes = allRepairs.filter(r => r?.status === 'SKIPPED');
            failedFixes = allRepairs.filter(r => r?.status === 'FAILED' || r?.status === 'UNSUPPORTED');
        }

        let toolchain = {
            qpdf: { available: false, version: null },
            ghostscript: { available: false, version: null }
        };
        try { 
            const qpdfOut = await execPromise('qpdf --version'); 
            toolchain.qpdf.available = true; 
            toolchain.qpdf.version = qpdfOut.stdout.split('\n')[0].trim();
        } catch (e) {}
        
        try { 
            let gsOut;
            if (process.platform === 'win32') {
                gsOut = await execPromise('gswin64c --version');
            } else {
                gsOut = await execPromise('gs --version');
            }
            toolchain.ghostscript.available = true; 
            toolchain.ghostscript.version = gsOut.stdout.split('\n')[0].trim();
        } catch (e) {}

        if (!toolchain.qpdf.available && requestedFixes.includes('REBUILD_XREF')) {
            skippedFixes.push({ fix_id: 'REBUILD_XREF', status: 'SKIPPED', reason: 'TOOL_NOT_AVAILABLE', message: 'qpdf not available' });
        }

        const hasCriticalFailed = failedFixes.some(f => f.risk_level === 'CRITICAL');
        let requiresReviewPolicy = reviewRequired || appliedFixes.some(f => f.risk_level === 'HIGH' || f.risk_level === 'CRITICAL' || f.requires_human_review);
        
        // Font Governance (Phase 51A)
        const fontFindings = (sourceFindings || []).filter(f => 
            ['NON_EMBEDDED_FONTS', 'TYPE3_FONTS', 'MISSING_GLYPHS', 'FONT_SUBSTITUTION_RISK'].includes(f.id || f.code)
        );
        
        if (fontFindings.length > 0) {
            requiresReviewPolicy = true;
            fontFindings.forEach(ff => {
                const id = ff.id || ff.code;
                if (!reviewRequiredReasons.includes(id)) {
                    reviewRequiredReasons.push(id);
                }
            });
        }

        // Color Governance (Phase 52B)
        const unsupportedColorFixesList = ['NORMALIZE_ICC_PROFILE', 'REDUCE_TAC', 'MAP_RICH_BLACK_TEXT_TO_K_ONLY', 'MAP_REGISTRATION_COLOR_TO_BLACK'];
        const colorFindingsList = ['EXCESSIVE_TAC', 'RICH_BLACK_TEXT', 'REGISTRATION_COLOR_MISUSE', 'ICC_MISMATCH', 'MIXED_RGB_CMYK', 'RGB_DEVICE_COLOR', 'RGB_IMAGES', 'MISSING_OUTPUT_INTENT', 'INVALID_OUTPUT_INTENT'];
        const reviewRequiredColorFindings = ['EXCESSIVE_TAC', 'RICH_BLACK_TEXT', 'REGISTRATION_COLOR_MISUSE', 'ICC_MISMATCH', 'MIXED_RGB_CMYK'];

        const wronglyAppliedColorFixes = appliedFixes.filter(f => unsupportedColorFixesList.includes(f.fix_id || f.code));
        if (wronglyAppliedColorFixes.length > 0) {
            wronglyAppliedColorFixes.forEach(f => {
                f.status = 'SKIPPED';
                f.reason = 'UNSUPPORTED_COLOR_FIX_WAS_REPORTED_AS_APPLIED';
                f.message = 'Capability is not fully supported or is high-risk.';
                f.requires_human_review = true;
                f.production_safe = false;
                f.moved_from_applied_to_skipped = true;
                skippedFixes.push(f);
            });
            appliedFixes = appliedFixes.filter(f => !unsupportedColorFixesList.includes(f.fix_id || f.code));
        }

        const wronglyAppliedFindings = appliedFixes.filter(f => colorFindingsList.includes(f.fix_id || f.code));
        if (wronglyAppliedFindings.length > 0) {
            appliedFixes = appliedFixes.filter(f => !colorFindingsList.includes(f.fix_id || f.code));
        }

        const colorFindings = (sourceFindings || []).filter(f => colorFindingsList.includes(f.id || f.code));
        const hasConvertCmyk = appliedFixes.some(f => f.fix_id === 'CONVERT_CMYK' || f.code === 'CONVERT_CMYK');
        const hasInjectOutputIntent = appliedFixes.some(f => f.fix_id === 'INJECT_OUTPUT_INTENT' || f.code === 'INJECT_OUTPUT_INTENT');
        
        let colorGovernanceHasRisks = false;
        let colorReviewReasons = [];

        colorFindings.forEach(cf => {
            const id = cf.id || cf.code;
            if (reviewRequiredColorFindings.includes(id)) {
                colorGovernanceHasRisks = true;
                if (!colorReviewReasons.includes(id)) colorReviewReasons.push(id);
            }
            if (['RGB_DEVICE_COLOR', 'RGB_IMAGES'].includes(id)) {
                if (!hasConvertCmyk) {
                    colorGovernanceHasRisks = true;
                    if (!colorReviewReasons.includes(id)) colorReviewReasons.push(id);
                }
            }
        });

        if (hasConvertCmyk) {
            colorGovernanceHasRisks = true;
            if (!colorReviewReasons.includes('CONVERT_CMYK')) colorReviewReasons.push('CONVERT_CMYK');
        }

        const requestedUnsupportedColorFixes = skippedFixes.filter(f => unsupportedColorFixesList.includes(f.fix_id || f.code));
        if (requestedUnsupportedColorFixes.length > 0) {
            colorGovernanceHasRisks = true;
            requestedUnsupportedColorFixes.forEach(f => {
                const id = f.fix_id || f.code;
                if (!colorReviewReasons.includes(id)) colorReviewReasons.push(id);
            });
        }

        if (colorGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            colorReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }
        
        if (requiresReviewPolicy) {
            productionCertified = false;
        }

        // Transparency / Overprint Governance (Phase 53B)
        const unsupportedTransparencyFixesList = ['FLATTEN_TRANSPARENCY', 'FLATTEN_PDF', 'FLATTEN_OVERPRINT', 'NORMALIZE_OVERPRINT', 'REMOVE_SOFT_MASKS', 'RASTERIZE_TRANSPARENCY', 'CONVERT_TO_PDFX_TRANSPARENCY_SAFE'];
        const transparencyFindingsList = ['TRANSPARENCY_PRESENT', 'TRANSPARENCY_GROUPS', 'SOFT_MASK_PRESENT', 'BLEND_MODE_PRESENT', 'OVERPRINT_PRESENT', 'OVERPRINT_MODE_PRESENT', 'KNOCKOUT_GROUP_PRESENT', 'FLATTENING_REQUIRED', 'UNSUPPORTED_TRANSPARENCY_FOR_PDFX', 'RASTERIZATION_RISK'];
        const reviewRequiredTransparencyFindings = ['TRANSPARENCY_PRESENT', 'SOFT_MASK_PRESENT', 'BLEND_MODE_PRESENT', 'OVERPRINT_PRESENT', 'OVERPRINT_MODE_PRESENT', 'KNOCKOUT_GROUP_PRESENT', 'RASTERIZATION_RISK'];
        const reviewRequiredTransparencyFixes = ['FLATTEN_TRANSPARENCY', 'FLATTEN_PDF', 'FLATTEN_OVERPRINT', 'RASTERIZE_TRANSPARENCY'];

        // 1. Move unsupported fixes from applied to skipped
        const wronglyAppliedTransparencyFixes = appliedFixes.filter(f => unsupportedTransparencyFixesList.includes(f.fix_id || f.code) && f.implemented === false);
        if (wronglyAppliedTransparencyFixes.length > 0) {
            wronglyAppliedTransparencyFixes.forEach(f => {
                f.status = 'SKIPPED';
                f.reason = 'UNSUPPORTED_TRANSPARENCY_OVERPRINT_FIX_WAS_REPORTED_AS_APPLIED';
                f.message = 'Capability is not fully supported or is high-risk.';
                f.requires_human_review = true;
                f.production_safe = false;
                f.moved_from_applied_to_skipped = true;
                skippedFixes.push(f);
            });
            appliedFixes = appliedFixes.filter(f => !unsupportedTransparencyFixesList.includes(f.fix_id || f.code));
        }

        // 2. Move findings out of applied fixes
        const wronglyAppliedTransparencyFindings = appliedFixes.filter(f => transparencyFindingsList.includes(f.fix_id || f.code));
        if (wronglyAppliedTransparencyFindings.length > 0) {
            wronglyAppliedTransparencyFindings.forEach(f => {
                const id = f.fix_id || f.code;
                reviewRequiredReasons.push({
                    id: id,
                    code: id,
                    moved_from_applied_to_review_reason: true,
                    reason: 'FINDING_WAS_REPORTED_AS_APPLIED_FIX'
                });
            });
            appliedFixes = appliedFixes.filter(f => !transparencyFindingsList.includes(f.fix_id || f.code));
        }

        const transparencyFindings = (sourceFindings || []).filter(f => transparencyFindingsList.includes(f.id || f.code));
        
        let transparencyGovernanceHasRisks = false;
        let transparencyReviewReasons = [];
        let pdfxComplianceClaimed = false; // Never claim compliance in this phase
        let transparencyPresent = false;
        let overprintPresent = false;
        let softMasksPresent = false;
        let blendModesPresent = false;
        let rasterizationRisk = false;

        let highestTransparencyRisk = 'LOW';
        const updateTransparencyRisk = (level) => {
            if (level === 'CRITICAL') highestTransparencyRisk = 'CRITICAL';
            if (level === 'HIGH' && highestTransparencyRisk !== 'CRITICAL') highestTransparencyRisk = 'HIGH';
        };

        transparencyFindings.forEach(tf => {
            const id = tf.id || tf.code;
            if (reviewRequiredTransparencyFindings.includes(id)) {
                transparencyGovernanceHasRisks = true;
                if (!transparencyReviewReasons.includes(id)) transparencyReviewReasons.push(id);
            }
            if (['TRANSPARENCY_PRESENT', 'TRANSPARENCY_GROUPS'].includes(id)) { transparencyPresent = true; updateTransparencyRisk('HIGH'); }
            if (['OVERPRINT_PRESENT', 'OVERPRINT_MODE_PRESENT'].includes(id)) { overprintPresent = true; updateTransparencyRisk('HIGH'); }
            if (id === 'SOFT_MASK_PRESENT') { softMasksPresent = true; updateTransparencyRisk('HIGH'); }
            if (id === 'BLEND_MODE_PRESENT') { blendModesPresent = true; updateTransparencyRisk('HIGH'); }
            if (id === 'RASTERIZATION_RISK') { rasterizationRisk = true; updateTransparencyRisk('CRITICAL'); }
            if (id === 'KNOCKOUT_GROUP_PRESENT') { updateTransparencyRisk('HIGH'); }
            if (id === 'UNSUPPORTED_TRANSPARENCY_FOR_PDFX') { updateTransparencyRisk('HIGH'); }
        });

        const requestedUnsupportedTransparencyFixes = skippedFixes.filter(f => unsupportedTransparencyFixesList.includes(f.fix_id || f.code));
        
        const appliedVisualRewriteFix = appliedFixes.filter(f => reviewRequiredTransparencyFixes.includes(f.fix_id || f.code));
        if (appliedVisualRewriteFix.length > 0) {
            transparencyGovernanceHasRisks = true;
            appliedVisualRewriteFix.forEach(f => {
                f.visually_sensitive = true;
                f.destructive = true;
                const id = f.fix_id || f.code;
                if (!transparencyReviewReasons.includes(id)) transparencyReviewReasons.push(id);
            });
        }

        if (transparencyGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            transparencyReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }
        
        if (requiresReviewPolicy) {
            productionCertified = false;
        }

        // Image Quality Governance (Phase 54B)
        const unsupportedImageFixesList = ['UPSCALE_LOW_RES_IMAGES', 'DOWNSAMPLE_EXCESSIVE_RESOLUTION', 'RECOMPRESS_IMAGES', 'REPLACE_LOW_RES_IMAGES', 'REPAIR_JPEG_ARTIFACTS', 'NORMALIZE_IMAGE_COLORSPACE', 'REMOVE_IMAGE_ALPHA', 'REPAIR_DAMAGED_IMAGE_OBJECT', 'VECTORIZE_BITMAP_TEXT', 'RESTORE_RASTERIZED_VECTOR'];
        const imageFindingsList = ['LOW_RES_IMAGES', 'EXCESSIVE_RESOLUTION', 'JPEG_ARTIFACTS', 'IMAGE_COMPRESSION_RISK', 'IMAGE_DOWNSAMPLING_RISK', 'IMAGE_UPSCALING_RISK', 'IMAGE_REPLACEMENT_REQUIRED', 'BITMAP_TEXT_RISK', 'RASTERIZED_VECTOR_RISK', 'IMAGE_COLORSPACE_RISK', 'IMAGE_ALPHA_RISK', 'IMAGE_OBJECT_DAMAGED'];
        const criticalImageFindings = ['LOW_RES_IMAGES', 'JPEG_ARTIFACTS', 'IMAGE_REPLACEMENT_REQUIRED', 'BITMAP_TEXT_RISK', 'RASTERIZED_VECTOR_RISK', 'IMAGE_OBJECT_DAMAGED'];

        // 1. Move unsupported fixes from applied to skipped
        const wronglyAppliedImageFixes = appliedFixes.filter(f => unsupportedImageFixesList.includes(f.fix_id || f.code) && f.implemented === false);
        if (wronglyAppliedImageFixes.length > 0) {
            wronglyAppliedImageFixes.forEach(f => {
                f.status = 'SKIPPED';
                f.reason = 'UNSUPPORTED_IMAGE_QUALITY_FIX_WAS_REPORTED_AS_APPLIED';
                f.message = 'Capability is not fully supported or is high-risk.';
                f.requires_human_review = true;
                f.production_safe = false;
                f.moved_from_applied_to_skipped = true;
                skippedFixes.push(f);
            });
            appliedFixes = appliedFixes.filter(f => !(unsupportedImageFixesList.includes(f.fix_id || f.code) && f.implemented === false));
        }

        // 2. Move findings out of applied fixes
        const wronglyAppliedImageFindings = appliedFixes.filter(f => imageFindingsList.includes(f.fix_id || f.code));
        if (wronglyAppliedImageFindings.length > 0) {
            wronglyAppliedImageFindings.forEach(f => {
                const id = f.fix_id || f.code;
                reviewRequiredReasons.push({
                    id: id,
                    code: id,
                    moved_from_applied_to_review_reason: true,
                    reason: 'FINDING_WAS_REPORTED_AS_APPLIED_FIX'
                });
            });
            appliedFixes = appliedFixes.filter(f => !imageFindingsList.includes(f.fix_id || f.code));
        }

        const imageFindings = (sourceFindings || []).filter(f => imageFindingsList.includes(f.id || f.code));
        
        let imageGovernanceHasRisks = false;
        let imageReviewReasons = [];
        
        let highestImageRisk = 'LOW';
        const updateImageRisk = (level) => {
            if (level === 'CRITICAL') highestImageRisk = 'CRITICAL';
            if (level === 'HIGH' && highestImageRisk !== 'CRITICAL') highestImageRisk = 'HIGH';
        };

        let lowResImagesPresent = false;
        let excessiveResolutionPresent = false;
        let jpegArtifactsPresent = false;
        let imageReplacementRequired = false;
        let bitmapTextRisk = false;
        let rasterizedVectorRisk = false;
        let imageObjectDamaged = false;

        imageFindings.forEach(f => {
            const id = f.id || f.code;
            if (criticalImageFindings.includes(id)) {
                imageGovernanceHasRisks = true;
                if (!imageReviewReasons.includes(id)) imageReviewReasons.push(id);
                updateImageRisk('CRITICAL');
            }
            if (id === 'EXCESSIVE_RESOLUTION') {
                excessiveResolutionPresent = true;
                updateImageRisk('HIGH');
                if (requestedFixes.includes('DOWNSAMPLE_EXCESSIVE_RESOLUTION') || requestedFixes.includes('RECOMPRESS_IMAGES')) {
                    imageGovernanceHasRisks = true;
                    if (!imageReviewReasons.includes(id)) imageReviewReasons.push(id);
                }
            }
            if (id === 'IMAGE_COLORSPACE_RISK') {
                updateImageRisk('HIGH');
                imageGovernanceHasRisks = true;
                if (!imageReviewReasons.includes(id)) imageReviewReasons.push(id);
            }
            if (id === 'LOW_RES_IMAGES') lowResImagesPresent = true;
            if (id === 'JPEG_ARTIFACTS') jpegArtifactsPresent = true;
            if (id === 'IMAGE_REPLACEMENT_REQUIRED') imageReplacementRequired = true;
            if (id === 'BITMAP_TEXT_RISK') bitmapTextRisk = true;
            if (id === 'RASTERIZED_VECTOR_RISK') rasterizedVectorRisk = true;
            if (id === 'IMAGE_OBJECT_DAMAGED') imageObjectDamaged = true;
            if (['IMAGE_COMPRESSION_RISK', 'IMAGE_DOWNSAMPLING_RISK', 'IMAGE_UPSCALING_RISK', 'IMAGE_ALPHA_RISK'].includes(id)) {
                updateImageRisk('HIGH');
            }
        });

        const requestedUnsupportedImageFixes = skippedFixes.filter(f => unsupportedImageFixesList.includes(f.fix_id || f.code));

        const appliedVisualImageRewriteFix = appliedFixes.filter(f => unsupportedImageFixesList.includes(f.fix_id || f.code));
        if (appliedVisualImageRewriteFix.length > 0) {
            imageGovernanceHasRisks = true;
            appliedVisualImageRewriteFix.forEach(f => {
                f.visually_sensitive = true;
                f.destructive = true;
                const id = f.fix_id || f.code;
                if (!imageReviewReasons.includes(id)) imageReviewReasons.push(id);
            });
        }

        if (imageGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            imageReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // Standards Certification Governance (Phase 55B)
        const standardsCapabilitiesList = [
            'VALIDATE_PDFX', 'VALIDATE_PDFA', 'GENERATE_PDFX', 'CONVERT_TO_PDFX', 
            'CONVERT_TO_PDFA', 'STRIP_INVALID_PDFX_METADATA', 'STRIP_INVALID_PDFA_METADATA', 
            'NORMALIZE_STANDARD_METADATA', 'INJECT_PDFX_OUTPUTINTENT', 'REPAIR_PDFX_OUTPUTINTENT', 
            'MARK_STANDARD_UNCERTIFIED', 'REVOKE_FALSE_CERTIFICATION', 'GENERATE_STANDARD_VALIDATION_REPORT'
        ];
        
        const standardsFindingsList = [
            'PDFX_MISSING', 'PDFX_INVALID', 'PDFX_CLAIMED_BUT_NOT_VALIDATED', 
            'PDFX_METADATA_CONFLICT', 'PDFA_METADATA_CONFLICT', 'PDF_STANDARD_UNKNOWN', 
            'OUTPUTINTENT_PRESENT_NOT_PDFX', 'OUTPUTINTENT_MISSING_FOR_STANDARD', 
            'OUTPUTINTENT_INVALID_FOR_STANDARD', 'PDFX_OUTPUTINTENT_CONFLICT', 
            'STANDARD_VALIDATOR_UNAVAILABLE', 'STANDARD_VALIDATION_FAILED', 
            'STANDARD_VALIDATION_REQUIRED', 'CERTIFIED_PDF_NOT_STANDARD_CERTIFIED', 
            'PRODUCTION_CERTIFIED_WITHOUT_STANDARD_VALIDATION', 'PDFX_TRANSPARENCY_CONFLICT', 
            'PDFX_FONT_CONFLICT', 'PDFX_COLOR_CONFLICT', 'PDFX_IMAGE_CONFLICT'
        ];
        
        const reviewRequiredStandardsFindings = [
            'PDFX_CLAIMED_BUT_NOT_VALIDATED', 'PDFX_INVALID', 'STANDARD_VALIDATOR_UNAVAILABLE', 
            'STANDARD_VALIDATION_FAILED', 'STANDARD_VALIDATION_REQUIRED', 
            'CERTIFIED_PDF_NOT_STANDARD_CERTIFIED', 'PRODUCTION_CERTIFIED_WITHOUT_STANDARD_VALIDATION'
        ];

        // 1. Move unsupported standards capabilities from applied to skipped
        const metadataCleanupList = ['STRIP_INVALID_PDFX_METADATA', 'STRIP_INVALID_PDFA_METADATA', 'NORMALIZE_STANDARD_METADATA', 'REVOKE_FALSE_CERTIFICATION', 'MARK_STANDARD_UNCERTIFIED', 'GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL'];
        const wronglyAppliedStandardsFixes = appliedFixes.filter(f => 
            standardsCapabilitiesList.includes(f.fix_id || f.code) && 
            !metadataCleanupList.includes(f.fix_id || f.code) &&
            (f.validator_available === false || f.implemented === false || !f.validation_performed)
        );
        if (wronglyAppliedStandardsFixes.length > 0) {
            wronglyAppliedStandardsFixes.forEach(f => {
                f.status = 'SKIPPED';
                f.reason = 'UNSUPPORTED_STANDARDS_CERTIFICATION_CAPABILITY_WAS_REPORTED_AS_APPLIED';
                f.message = 'Capability is not fully supported or is high-risk.';
                f.requires_human_review = true;
                f.production_safe = false;
                f.moved_from_applied_to_skipped = true;
                skippedFixes.push(f);
            });
            appliedFixes = appliedFixes.filter(f => !wronglyAppliedStandardsFixes.includes(f));
        }

        // 2. Move findings out of applied fixes
        const wronglyAppliedStandardsFindings = appliedFixes.filter(f => standardsFindingsList.includes(f.fix_id || f.code));
        if (wronglyAppliedStandardsFindings.length > 0) {
            wronglyAppliedStandardsFindings.forEach(f => {
                const id = f.fix_id || f.code;
                reviewRequiredReasons.push(id);
                // Also add an object shape if needed, but array of strings is standard
            });
            appliedFixes = appliedFixes.filter(f => !wronglyAppliedStandardsFindings.includes(f));
        }

        const standardsFindings = (sourceFindings || []).filter(f => standardsFindingsList.includes(f.id || f.code));
        
        let standardsGovernanceHasRisks = false;
        let standardsReviewReasons = [];
        let standardCertified = false;
        let certifiedPdfAllowedStandards = true;
        
        pdfxComplianceClaimed = result?.pdfx_compliance_claimed || data?.pdfx_compliance_claimed || false;
        let pdfaComplianceClaimed = result?.pdfa_compliance_claimed || data?.pdfa_compliance_claimed || false;
        let standardClaimed = result?.standard_claimed || data?.standard_claimed || null;
        let complianceClaimAllowed = result?.compliance_claim_allowed || data?.compliance_claim_allowed || false;
        
        let validatorName = result?.validator_name || data?.validator_name || null;
        let validatorVersion = result?.validator_version || data?.validator_version || null;
        let validationPerformed = result?.validation_performed || data?.validation_performed || false;
        let validationPassed = result?.validation_passed || data?.validation_passed || false;
        let standardDetected = result?.standard_detected || data?.standard_detected || null;
        let validationReportAvailable = result?.validation_report_available || data?.validation_report_available || false;
        let validatorRequired = true;
        let validatorAvailable = false;
        let outputintentOnly = false;
        let outputintentDoesNotProvePdfx = true;
        let unsupportedStandardsFixes = [];

        let detectorGap = result?.detector_gap || data?.detector_gap || false;
        let fixtureGap = result?.fixture_gap || data?.fixture_gap || false;
        let validatorGap = result?.validator_gap || data?.validator_gap || false;
        let deferredGap = result?.deferred || data?.deferred || false;

        if (validatorGap) {
            validationPerformed = false;
            validationPassed = false;
        }

        standardsFindings.forEach(f => {
            const id = f.id || f.code;
            if (reviewRequiredStandardsFindings.includes(id)) {
                standardsGovernanceHasRisks = true;
                if (!standardsReviewReasons.includes(id)) standardsReviewReasons.push(id);
                standardCertified = false;
                certifiedPdfAllowedStandards = false;
            }
            if (id === 'PDFX_MISSING') {
                standardCertified = false;
                pdfxComplianceClaimed = false;
            }
        });

        // 3. Check for Inject Output Intent
        const hasInjectOutputIntentStandards = appliedFixes.some(f => ['INJECT_OUTPUT_INTENT', 'INJECT_PDFX_OUTPUTINTENT'].includes(f.fix_id || f.code));
        if (hasInjectOutputIntentStandards) {
            outputintentOnly = true;
            pdfxComplianceClaimed = false;
            standardCertified = false;
            complianceClaimAllowed = false;
            outputintentDoesNotProvePdfx = true;
        }

        // 4. Overclaim protection
        let hasValidatorEvidence = !!(validatorName && validatorVersion && validationPerformed && validationPassed && standardDetected && validationReportAvailable);
        
        const validatePdfxApplied = appliedFixes.find(f => (f.fix_id || f.code) === 'VALIDATE_PDFX');
        if (validatePdfxApplied) {
            if (validatePdfxApplied.validation_passed && validatePdfxApplied.validation_performed && validatePdfxApplied.validator_name) {
                hasValidatorEvidence = true;
                validationPassed = true;
                validationPerformed = true;
                validatorName = validatePdfxApplied.validator_name;
                validatorVersion = validatePdfxApplied.validator_version;
                standardDetected = validatePdfxApplied.standard_detected;
                validationReportAvailable = validatePdfxApplied.validation_report_available;
                validatorAvailable = true;
                complianceClaimAllowed = true;
            }
        }

        if ((pdfxComplianceClaimed || pdfaComplianceClaimed || standardCertified || complianceClaimAllowed || (standardClaimed && standardClaimed.startsWith('PDF/'))) && !hasValidatorEvidence) {
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            standardCertified = false;
            complianceClaimAllowed = false;
            standardClaimed = null;
            standardsGovernanceHasRisks = true;
            if (!standardsReviewReasons.includes('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE')) standardsReviewReasons.push('STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE');
            certifiedPdfAllowedStandards = false;
        }

        if (hasValidatorEvidence && !standardsGovernanceHasRisks) {
            standardCertified = true;
            pdfxComplianceClaimed = true;
            complianceClaimAllowed = true;
        }

        const requestedUnsupportedStandardsFixes = skippedFixes.filter(f => standardsCapabilitiesList.includes(f.fix_id || f.code));
        if (requestedUnsupportedStandardsFixes.length > 0) {
            validatorRequired = true;
            validatorAvailable = false;
            complianceClaimAllowed = false;
            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            unsupportedStandardsFixes = requestedUnsupportedStandardsFixes.map(f => f.fix_id || f.code);
        }

        if (standardsGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            standardsReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 61B: Structural / Metadata Governance ---
        const objectStreamsNormalized = appliedFixes.some(f => f.fix_id === 'NORMALIZE_OBJECT_STREAMS' || f.code === 'NORMALIZE_OBJECT_STREAMS');
        const falseCertificationRevoked = appliedFixes.some(f => f.fix_id === 'REVOKE_FALSE_CERTIFICATION' || f.code === 'REVOKE_FALSE_CERTIFICATION');
        const invalidPdfxMetadataStripped = appliedFixes.some(f => f.fix_id === 'STRIP_INVALID_PDFX_METADATA' || f.code === 'STRIP_INVALID_PDFX_METADATA');
        const invalidPdfaMetadataStripped = appliedFixes.some(f => f.fix_id === 'STRIP_INVALID_PDFA_METADATA' || f.code === 'STRIP_INVALID_PDFA_METADATA');
        const standardMetadataNormalized = appliedFixes.some(f => f.fix_id === 'NORMALIZE_STANDARD_METADATA' || f.code === 'NORMALIZE_STANDARD_METADATA');
        const internalStandardReportGenerated = appliedFixes.some(f => f.fix_id === 'GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL' || f.code === 'GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL');

        const structuralFixApplied = objectStreamsNormalized;
        const metadataCleanupApplied = falseCertificationRevoked || invalidPdfxMetadataStripped || invalidPdfaMetadataStripped || standardMetadataNormalized;

        let structuralMetadataGovernanceHasRisks = false;
        let structuralMetadataReviewReasons = [];
        let structuralMetadataWarnings = [];

        let qpdfAvailable = toolchain.qpdf.available;
        let qpdfWarnings = false;
        if (result?.qpdf_warnings || data?.qpdf_warnings) qpdfWarnings = true;

        if (internalStandardReportGenerated) {
            validationPerformed = false;
            validationPassed = false;
            hasValidatorEvidence = false;
            complianceClaimAllowed = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            standardCertified = false;
            structuralMetadataWarnings.push("Internal standards report generated. This does not constitute validator evidence.");
        }

        if (metadataCleanupApplied) {
            structuralMetadataWarnings.push("Metadata cleanup removed false or invalid claims.");
            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            complianceClaimAllowed = false;
            productionCertified = false;
        }

        if (objectStreamsNormalized) {
            if (result?.production_safe !== true) {
                productionCertified = false;
            }
        }

        const structuralMetadataGovernance = {
            review_required: structuralMetadataGovernanceHasRisks,
            production_certified: !structuralMetadataGovernanceHasRisks && productionCertified,
            certified_pdf_allowed: !structuralMetadataGovernanceHasRisks,
            structural_fix_applied: structuralFixApplied,
            metadata_cleanup_applied: metadataCleanupApplied,
            object_streams_normalized: objectStreamsNormalized,
            false_certification_revoked: falseCertificationRevoked,
            invalid_pdfx_metadata_stripped: invalidPdfxMetadataStripped,
            invalid_pdfa_metadata_stripped: invalidPdfaMetadataStripped,
            standard_metadata_normalized: standardMetadataNormalized,
            internal_standard_report_generated: internalStandardReportGenerated,
            qpdf_available: qpdfAvailable,
            qpdf_warnings: qpdfWarnings,
            metadata_cleanup_warnings: metadataCleanupApplied,
            standards_claim_allowed: complianceClaimAllowed,
            standard_certified: standardCertified,
            pdfx_compliance_claimed: pdfxComplianceClaimed,
            pdfa_compliance_claimed: pdfaComplianceClaimed,
            compliance_claim_allowed: complianceClaimAllowed,
            validation_performed: validationPerformed,
            validation_passed: validationPassed,
            review_required_reasons: structuralMetadataReviewReasons,
            warnings: structuralMetadataWarnings
        };

        if (structuralMetadataGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            structuralMetadataReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 62B: Page Marks Governance ---
        const pageMarksFixesList = ['ADD_CROP_MARKS', 'REMOVE_REGISTRATION_MARKS', 'NORMALIZE_PAGE_MARKS'];
        
        const appliedPageMarksFixes = appliedFixes.filter(f => pageMarksFixesList.includes(f.fix_id || f.code));
        const skippedPageMarksFixes = skippedFixes.filter(f => pageMarksFixesList.includes(f.fix_id || f.code));
        
        let pageMarksGovernanceHasRisks = false;
        let pageMarksReviewReasons = [];
        let pageMarksWarnings = [];
        let pageMarksEvidence = {};
        
        const failedPageMarksFixes = failedFixes.filter(f => pageMarksFixesList.includes(f.fix_id || f.code));
        const allPageMarksFixes = [...appliedPageMarksFixes, ...skippedPageMarksFixes, ...failedPageMarksFixes];

        allPageMarksFixes.forEach(f => {
            if (!f.evidence) {
                const synthesized = {
                    status: f.status,
                    capability: f.fix_id || f.code
                };
                if (f.reason || f.skip_reason) synthesized.reason = f.reason || f.skip_reason;
                if (f.warnings) synthesized.warnings = f.warnings;
                if (f.limitations) synthesized.limitations = f.limitations;
                if (f.safety_checks) synthesized.safety_checks = f.safety_checks;
                if (f.mark_geometry) synthesized.mark_geometry = f.mark_geometry;
                if (f.detection_confidence) synthesized.detection_confidence = f.detection_confidence;
                
                f.evidence = synthesized;
            }
            const id = f.fix_id || f.code;
            pageMarksEvidence[id] = f.evidence;
        });
        
        const pageMarksFixApplied = appliedPageMarksFixes.length > 0;
        const cropMarksAdded = appliedPageMarksFixes.some(f => (f.fix_id || f.code) === 'ADD_CROP_MARKS');
        const registrationMarksRemoved = appliedPageMarksFixes.some(f => (f.fix_id || f.code) === 'REMOVE_REGISTRATION_MARKS');
        const pageMarksNormalized = appliedPageMarksFixes.some(f => (f.fix_id || f.code) === 'NORMALIZE_PAGE_MARKS');
        
        let unsafeGeometryDetected = false;
        let insufficientMargin = false;
        let marksInsideTrim = false;
        let removalNotSafe = false;

        if (pageMarksFixApplied) {
            pageMarksGovernanceHasRisks = true;
            pageMarksWarnings.push("Page marks affect print interpretation and require visual review.");
            
            // Standards claims cannot be made
            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            complianceClaimAllowed = false;
            productionCertified = false;
            
            appliedPageMarksFixes.forEach(f => {
                const id = f.fix_id || f.code;
                if (!pageMarksReviewReasons.includes(id)) pageMarksReviewReasons.push(id);
            });
        }
        
        skippedPageMarksFixes.forEach(f => {
            const id = f.fix_id || f.code;
            const reason = f.reason || '';
            
            if (reason === 'UNSAFE_GEOMETRY' || f.safety_checks?.safe === false) unsafeGeometryDetected = true;
            if (reason === 'INSUFFICIENT_MARGIN') insufficientMargin = true;
            if (reason === 'MARKS_INSIDE_TRIM') marksInsideTrim = true;
            if (reason === 'DETECTION_OR_REMOVAL_NOT_SAFE' || reason === 'UNSAFE_REMOVAL') removalNotSafe = true;
            
            // Unsafe geometry needs review if finding persists
            if (unsafeGeometryDetected || insufficientMargin || marksInsideTrim || removalNotSafe) {
                if (!pageMarksReviewReasons.includes(id + '_SKIPPED_UNSAFE')) {
                    pageMarksReviewReasons.push(id + '_SKIPPED_UNSAFE');
                }
            }
        });

        if (pageMarksReviewReasons.length > 0) {
            pageMarksGovernanceHasRisks = true;
        }

        const pageMarksGovernance = {
            review_required: pageMarksGovernanceHasRisks,
            production_certified: false,
            certified_pdf_allowed: false,
            page_marks_fix_applied: pageMarksFixApplied,
            crop_marks_added: cropMarksAdded,
            registration_marks_removed: registrationMarksRemoved,
            page_marks_normalized: pageMarksNormalized,
            unsafe_geometry_detected: unsafeGeometryDetected,
            insufficient_margin: insufficientMargin,
            marks_inside_trim: marksInsideTrim,
            removal_not_safe: removalNotSafe,
            visually_sensitive: pageMarksFixApplied,
            standard_certified: false,
            pdfx_compliance_claimed: false,
            pdfa_compliance_claimed: false,
            compliance_claim_allowed: false,
            review_required_reasons: pageMarksReviewReasons,
            warnings: pageMarksWarnings,
            evidence: pageMarksEvidence
        };
        
        if (pageMarksGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            pageMarksReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 63B: Security / Interactive Object Governance ---
        const securityInteractivityFixesList = [
            'STRIP_JAVASCRIPT', 'REMOVE_LAUNCH_ACTIONS', 'REMOVE_EMBEDDED_FILES',
            'REMOVE_DOCUMENT_OPEN_ACTIONS', 'REMOVE_PAGE_OPEN_ACTIONS',
            'FLATTEN_ANNOTATIONS', 'FLATTEN_FORMS'
        ];

        const appliedSecurityInteractivityFixes = appliedFixes.filter(f => securityInteractivityFixesList.includes(f.fix_id || f.code));
        const skippedSecurityInteractivityFixes = skippedFixes.filter(f => securityInteractivityFixesList.includes(f.fix_id || f.code));
        const failedSecurityInteractivityFixes = failedFixes.filter(f => securityInteractivityFixesList.includes(f.fix_id || f.code));
        const allSecurityInteractivityFixes = [...appliedSecurityInteractivityFixes, ...skippedSecurityInteractivityFixes, ...failedSecurityInteractivityFixes];

        let securityInteractivityGovernanceHasRisks = false;
        let securityInteractivityReviewReasons = [];
        let securityInteractivityWarnings = [];
        let securityInteractivityEvidence = {};

        allSecurityInteractivityFixes.forEach(f => {
            if (!f.evidence) {
                const synthesized = {
                    status: f.status,
                    capability: f.fix_id || f.code
                };
                if (f.reason || f.skip_reason) synthesized.reason = f.reason || f.skip_reason;
                if (f.warnings) synthesized.warnings = f.warnings;
                if (f.limitations) synthesized.limitations = f.limitations;
                f.evidence = synthesized;
            }
            const id = f.fix_id || f.code;
            securityInteractivityEvidence[id] = f.evidence;
        });

        const isApplied = (capability) => appliedSecurityInteractivityFixes.some(f => (f.fix_id || f.code) === capability);
        const isSkipped = (capability) => skippedSecurityInteractivityFixes.some(f => (f.fix_id || f.code) === capability);

        const securityInteractivityFixApplied = appliedSecurityInteractivityFixes.length > 0;
        const javascriptRemoved = isApplied('STRIP_JAVASCRIPT');
        const launchActionsRemoved = isApplied('REMOVE_LAUNCH_ACTIONS');
        const embeddedFilesRemoved = isApplied('REMOVE_EMBEDDED_FILES');
        const documentOpenActionsRemoved = isApplied('REMOVE_DOCUMENT_OPEN_ACTIONS');
        const pageOpenActionsRemoved = isApplied('REMOVE_PAGE_OPEN_ACTIONS');
        const annotationsFlattened = isApplied('FLATTEN_ANNOTATIONS');
        const formsFlattened = isApplied('FLATTEN_FORMS');
        const annotationFlattenSkipped = isSkipped('FLATTEN_ANNOTATIONS');
        const formFlattenSkipped = isSkipped('FLATTEN_FORMS');

        const activeContentRemoved = javascriptRemoved || launchActionsRemoved || embeddedFilesRemoved
            || documentOpenActionsRemoved || pageOpenActionsRemoved;

        const uncertainReasons = ['SKIPPED_UNCERTAIN', 'REVIEW_REQUIRED', 'SKIPPED_UNSUPPORTED'];
        let unresolvedInteractiveContent = false;
        [...skippedSecurityInteractivityFixes, ...failedSecurityInteractivityFixes].forEach(f => {
            const id = f.fix_id || f.code;
            const reason = f.reason || f.skip_reason || f.status || '';
            if (uncertainReasons.includes(reason)) {
                unresolvedInteractiveContent = true;
                if (!securityInteractivityReviewReasons.includes(id + '_' + reason)) {
                    securityInteractivityReviewReasons.push(id + '_' + reason);
                }
            }
        });

        const visuallySensitive = annotationsFlattened || formsFlattened;
        const securitySensitive = allSecurityInteractivityFixes.length > 0;

        if (securityInteractivityFixApplied) {
            securityInteractivityGovernanceHasRisks = true;
            securityInteractivityWarnings.push("Security/interactivity cleanup affects PDF object structure and requires review.");

            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            complianceClaimAllowed = false;
            productionCertified = false;

            appliedSecurityInteractivityFixes.forEach(f => {
                const id = f.fix_id || f.code;
                if (!securityInteractivityReviewReasons.includes(id)) securityInteractivityReviewReasons.push(id);
            });
        }

        if (visuallySensitive) {
            securityInteractivityWarnings.push("Annotation/form flattening may alter visual appearance and requires human review.");
        }

        if (unresolvedInteractiveContent) {
            securityInteractivityGovernanceHasRisks = true;
        }

        if (securityInteractivityReviewReasons.length > 0) {
            securityInteractivityGovernanceHasRisks = true;
        }

        const securityInteractivityGovernance = {
            review_required: securityInteractivityGovernanceHasRisks,
            production_certified: false,
            certified_pdf_allowed: false,
            security_interactivity_fix_applied: securityInteractivityFixApplied,
            active_content_removed: activeContentRemoved,
            javascript_removed: javascriptRemoved,
            launch_actions_removed: launchActionsRemoved,
            embedded_files_removed: embeddedFilesRemoved,
            document_open_actions_removed: documentOpenActionsRemoved,
            page_open_actions_removed: pageOpenActionsRemoved,
            annotations_flattened: annotationsFlattened,
            annotation_flatten_skipped: annotationFlattenSkipped,
            forms_flattened: formsFlattened,
            form_flatten_skipped: formFlattenSkipped,
            unresolved_interactive_content: unresolvedInteractiveContent,
            visually_sensitive: visuallySensitive,
            security_sensitive: securitySensitive,
            standard_certified: false,
            pdfx_compliance_claimed: false,
            pdfa_compliance_claimed: false,
            compliance_claim_allowed: false,
            review_required_reasons: securityInteractivityReviewReasons,
            warnings: securityInteractivityWarnings,
            evidence: securityInteractivityEvidence
        };

        if (securityInteractivityGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            securityInteractivityReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 64B: Ink Governance ---
        const inkGovernanceFixesList = [
            'REDUCE_TOTAL_INK_COVERAGE', 'MAP_RICH_BLACK_TEXT_TO_K_ONLY',
            'MAP_REGISTRATION_COLOR_TO_BLACK', 'NORMALIZE_BLACK_TEXT',
            'DETECT_SMALL_TEXT_RICH_BLACK'
        ];

        const appliedInkFixes = appliedFixes.filter(f => inkGovernanceFixesList.includes(f.fix_id || f.code));
        const skippedInkFixes = skippedFixes.filter(f => inkGovernanceFixesList.includes(f.fix_id || f.code));
        const failedInkFixes = failedFixes.filter(f => inkGovernanceFixesList.includes(f.fix_id || f.code));
        const allInkFixes = [...appliedInkFixes, ...skippedInkFixes, ...failedInkFixes];

        let inkGovernanceWarnings = [];
        let inkGovernanceReviewReasons = [];
        let inkGovernanceEvidence = {};

        allInkFixes.forEach(f => {
            if (!f.evidence) {
                const synthesized = {
                    status: f.status,
                    capability: f.fix_id || f.code
                };
                if (f.reason || f.skip_reason) synthesized.reason = f.reason || f.skip_reason;
                if (f.warnings) synthesized.warnings = f.warnings;
                if (f.limitations) synthesized.limitations = f.limitations;
                f.evidence = synthesized;
            }
            const id = f.fix_id || f.code;
            inkGovernanceEvidence[id] = f.evidence;
        });

        const isInkApplied = (capability) => appliedInkFixes.some(f => (f.fix_id || f.code) === capability);
        const isInkAttempted = (capability) => allInkFixes.some(f => (f.fix_id || f.code) === capability);

        const inkFixApplied = appliedInkFixes.length > 0;
        const tacReductionAttempted = isInkAttempted('REDUCE_TOTAL_INK_COVERAGE');
        const tacReductionApplied = isInkApplied('REDUCE_TOTAL_INK_COVERAGE');
        const richBlackTextMapped = isInkApplied('MAP_RICH_BLACK_TEXT_TO_K_ONLY');
        const registrationColorMapped = isInkApplied('MAP_REGISTRATION_COLOR_TO_BLACK');
        const blackTextNormalized = isInkApplied('NORMALIZE_BLACK_TEXT');
        const smallTextRichBlackDetected = isInkAttempted('DETECT_SMALL_TEXT_RICH_BLACK');

        const visualChangeExpected = inkFixApplied;
        const inkGovernanceHasRisks = allInkFixes.length > 0;

        if (inkGovernanceHasRisks) {
            inkGovernanceWarnings.push("Ink/color changes may affect appearance and require review.");
            allInkFixes.forEach(f => {
                const id = f.fix_id || f.code;
                if (!inkGovernanceReviewReasons.includes(id)) inkGovernanceReviewReasons.push(id);
            });
        }

        const inkGovernance = {
            review_required: true,
            production_certified: false,
            certified_pdf_allowed: false,
            ink_fix_applied: inkFixApplied,
            tac_reduction_attempted: tacReductionAttempted,
            tac_reduction_applied: tacReductionApplied,
            rich_black_text_mapped: richBlackTextMapped,
            registration_color_mapped: registrationColorMapped,
            black_text_normalized: blackTextNormalized,
            small_text_rich_black_detected: smallTextRichBlackDetected,
            visual_change_expected: visualChangeExpected,
            standard_certified: false,
            pdfx_compliance_claimed: false,
            pdfa_compliance_claimed: false,
            compliance_claim_allowed: false,
            review_required_reasons: inkGovernanceReviewReasons,
            warnings: inkGovernanceWarnings,
            evidence: inkGovernanceEvidence
        };

        if (inkGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            complianceClaimAllowed = false;
            inkGovernanceReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 65B: Selective Image Governance ---
        const selectiveImageFixesList = [
            'CONVERT_IMAGE_RGB_TO_CMYK_SELECTIVE', 'TAG_UNTAGGED_IMAGES',
            'NORMALIZE_IMAGE_ICC_PROFILE', 'DOWNSAMPLE_EXCESSIVE_RESOLUTION',
            'FLAG_LOW_RES_IMAGES_UNFIXABLE'
        ];

        const appliedSelectiveImageFixes = appliedFixes.filter(f => selectiveImageFixesList.includes(f.fix_id || f.code));
        const skippedSelectiveImageFixes = skippedFixes.filter(f => selectiveImageFixesList.includes(f.fix_id || f.code));
        const failedSelectiveImageFixes = failedFixes.filter(f => selectiveImageFixesList.includes(f.fix_id || f.code));
        const allSelectiveImageFixes = [...appliedSelectiveImageFixes, ...skippedSelectiveImageFixes, ...failedSelectiveImageFixes];

        let selectiveImageWarnings = [];
        let selectiveImageReviewReasons = [];
        let selectiveImageEvidence = {};

        allSelectiveImageFixes.forEach(f => {
            if (!f.evidence) {
                const synthesized = {
                    status: f.status,
                    capability: f.fix_id || f.code
                };
                if (f.reason || f.skip_reason) synthesized.reason = f.reason || f.skip_reason;
                if (f.warnings) synthesized.warnings = f.warnings;
                if (f.limitations) synthesized.limitations = f.limitations;
                f.evidence = synthesized;
            }
            const id = f.fix_id || f.code;
            selectiveImageEvidence[id] = f.evidence;
        });

        const isSelectiveImageApplied = (capability) => appliedSelectiveImageFixes.some(f => (f.fix_id || f.code) === capability);
        const isSelectiveImageAttempted = (capability) => allSelectiveImageFixes.some(f => (f.fix_id || f.code) === capability);

        const selectiveImageFixApplied = appliedSelectiveImageFixes.length > 0;
        const rgbImagesConverted = isSelectiveImageApplied('CONVERT_IMAGE_RGB_TO_CMYK_SELECTIVE');
        const imageProfilesNormalized = isSelectiveImageApplied('NORMALIZE_IMAGE_ICC_PROFILE') || isSelectiveImageApplied('TAG_UNTAGGED_IMAGES');
        const excessiveResolutionDownsampled = isSelectiveImageApplied('DOWNSAMPLE_EXCESSIVE_RESOLUTION');
        const lowResUnfixable = isSelectiveImageAttempted('FLAG_LOW_RES_IMAGES_UNFIXABLE');

        const visualChangeExpectedSelectiveImage = rgbImagesConverted || imageProfilesNormalized || excessiveResolutionDownsampled;
        const selectiveImageGovernanceHasRisks = allSelectiveImageFixes.length > 0;

        if (selectiveImageGovernanceHasRisks) {
            selectiveImageWarnings.push("Selective image fixes (RGB-to-CMYK conversion, ICC normalization, tagging, downsampling) cause visual change and require human review.");
            allSelectiveImageFixes.forEach(f => {
                const id = f.fix_id || f.code;
                if (!selectiveImageReviewReasons.includes(id)) selectiveImageReviewReasons.push(id);
            });
        }

        if (lowResUnfixable) {
            selectiveImageWarnings.push("Low-resolution images cannot be safely improved automatically; upscaling is never performed.");
        }

        const selectiveImageGovernance = {
            review_required: true,
            production_certified: false,
            certified_pdf_allowed: false,
            image_fix_applied: selectiveImageFixApplied,
            rgb_images_converted: rgbImagesConverted,
            image_profiles_normalized: imageProfilesNormalized,
            excessive_resolution_downsampled: excessiveResolutionDownsampled,
            low_res_unfixable: lowResUnfixable,
            visual_change_expected: visualChangeExpectedSelectiveImage,
            standard_certified: false,
            pdfx_compliance_claimed: false,
            pdfa_compliance_claimed: false,
            compliance_claim_allowed: false,
            review_required_reasons: selectiveImageReviewReasons,
            warnings: selectiveImageWarnings,
            evidence: selectiveImageEvidence
        };

        if (selectiveImageGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            complianceClaimAllowed = false;
            selectiveImageReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 66B: Font Governance ---
        const fontGovernanceFixesList = [
            'EMBED_FONTS', 'SUBSET_EMBEDDED_FONTS', 'OUTLINE_TYPE3_FONTS',
            'REPAIR_FONT_ENCODING', 'FLAG_MISSING_GLYPHS_UNFIXABLE'
        ];
        const fontOutlineDestructiveFixesList = [
            'OUTLINE_TYPE3_FONTS', 'REPAIR_FONT_ENCODING', 'EMBED_FONTS', 'SUBSET_EMBEDDED_FONTS'
        ];

        const appliedFontFixes = appliedFixes.filter(f => fontGovernanceFixesList.includes(f.fix_id || f.code));
        const skippedFontFixes = skippedFixes.filter(f => fontGovernanceFixesList.includes(f.fix_id || f.code));
        const failedFontFixes = failedFixes.filter(f => fontGovernanceFixesList.includes(f.fix_id || f.code));
        const allFontFixes = [...appliedFontFixes, ...skippedFontFixes, ...failedFontFixes];

        let fontGovernanceWarnings = [];
        let fontGovernanceReviewReasons = [];
        let fontGovernanceEvidence = {};

        let fontsEmbedded = false;
        let fontEmbeddingSkipped = false;
        let type3FontsDetected = false;
        let glyphsMissingUnfixable = false;
        let fontSourceAvailable = null;

        allFontFixes.forEach(f => {
            if (!f.evidence) {
                const synthesized = {
                    status: f.status,
                    capability: f.fix_id || f.code
                };
                if (f.reason || f.skip_reason) synthesized.reason = f.reason || f.skip_reason;
                if (f.warnings) synthesized.warnings = f.warnings;
                if (f.limitations) synthesized.limitations = f.limitations;
                f.evidence = synthesized;
            }
            const id = f.fix_id || f.code;
            fontGovernanceEvidence[id] = f.evidence;

            if (f.evidence.fonts_embedded === true) fontsEmbedded = true;
            if (f.evidence.font_embedding_skipped === true) fontEmbeddingSkipped = true;
            if (f.evidence.type3_fonts_detected === true) type3FontsDetected = true;
            if (f.evidence.glyphs_missing_unfixable === true) glyphsMissingUnfixable = true;
            if (typeof f.evidence.font_source_available === 'boolean') fontSourceAvailable = f.evidence.font_source_available;
        });

        const isFontFixApplied = (capability) => appliedFontFixes.some(f => (f.fix_id || f.code) === capability);
        const isFontFixAttempted = (capability) => allFontFixes.some(f => (f.fix_id || f.code) === capability);

        const fontFixApplied = appliedFontFixes.length > 0;
        const destructiveFontOperationsAttempted = allFontFixes.filter(f => fontOutlineDestructiveFixesList.includes(f.fix_id || f.code));
        const fontGovernanceHasRisks = allFontFixes.length > 0;

        if (fontGovernanceHasRisks) {
            fontGovernanceWarnings.push("Font fixes (embedding, subsetting, outlining Type3 fonts, encoding repair) change PDF structure and require human review.");
            allFontFixes.forEach(f => {
                const id = f.fix_id || f.code;
                if (!fontGovernanceReviewReasons.includes(id)) fontGovernanceReviewReasons.push(id);
            });
        }

        if (fontEmbeddingSkipped) {
            fontGovernanceWarnings.push("Font embedding could not be completed because font sources were unavailable; fonts were not invented or substituted.");
        }
        if (type3FontsDetected) {
            fontGovernanceWarnings.push("Type3 fonts detected; outlining is a destructive operation and requires review.");
        }
        if (glyphsMissingUnfixable) {
            fontGovernanceWarnings.push("Missing glyphs could not be safely synthesized; they remain unfixed and flagged for review.");
        }

        const fontGovernance = {
            review_required: true,
            production_certified: false,
            certified_pdf_allowed: false,
            font_fix_applied: fontFixApplied,
            fonts_embedded: fontsEmbedded,
            font_embedding_skipped: fontEmbeddingSkipped,
            type3_fonts_detected: type3FontsDetected,
            type3_fonts_outlined: isFontFixApplied('OUTLINE_TYPE3_FONTS'),
            font_encoding_repaired: isFontFixApplied('REPAIR_FONT_ENCODING'),
            embedded_fonts_subset: isFontFixApplied('SUBSET_EMBEDDED_FONTS'),
            glyphs_missing_unfixable: glyphsMissingUnfixable,
            font_source_available: fontSourceAvailable,
            destructive_operations_attempted: destructiveFontOperationsAttempted.map(f => f.fix_id || f.code),
            standard_certified: false,
            pdfx_compliance_claimed: false,
            pdfa_compliance_claimed: false,
            compliance_claim_allowed: false,
            review_required_reasons: fontGovernanceReviewReasons,
            warnings: fontGovernanceWarnings,
            evidence: fontGovernanceEvidence
        };

        if (fontGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            complianceClaimAllowed = false;
            fontGovernanceReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 67B: Transparency / Overprint Physical Governance ---
        const transparencyOverprintPhysicalFixesList = [
            'FLATTEN_TRANSPARENCY', 'NORMALIZE_BLEND_MODES',
            'FLATTEN_OVERPRINT', 'SIMULATE_OVERPRINT_PREVIEW'
        ];

        const appliedTransparencyPhysicalFixes = appliedFixes.filter(f => transparencyOverprintPhysicalFixesList.includes(f.fix_id || f.code));
        const skippedTransparencyPhysicalFixes = skippedFixes.filter(f => transparencyOverprintPhysicalFixesList.includes(f.fix_id || f.code));
        const failedTransparencyPhysicalFixes = failedFixes.filter(f => transparencyOverprintPhysicalFixesList.includes(f.fix_id || f.code));
        const allTransparencyPhysicalFixes = [...appliedTransparencyPhysicalFixes, ...skippedTransparencyPhysicalFixes, ...failedTransparencyPhysicalFixes];

        let transparencyPhysicalWarnings = [];
        let transparencyPhysicalReviewReasons = [];
        let transparencyPhysicalEvidence = {};

        let physicalRenderingSafetyProven = false;
        let physicalVisualChangeExpected = false;

        allTransparencyPhysicalFixes.forEach(f => {
            if (!f.evidence) {
                const synthesized = {
                    status: f.status,
                    capability: f.fix_id || f.code
                };
                if (f.reason || f.skip_reason) synthesized.reason = f.reason || f.skip_reason;
                if (f.warnings) synthesized.warnings = f.warnings;
                if (f.limitations) synthesized.limitations = f.limitations;
                if (typeof f.rendering_safety_proven === 'boolean') synthesized.rendering_safety_proven = f.rendering_safety_proven;
                if (typeof f.visual_change_expected === 'boolean') synthesized.visual_change_expected = f.visual_change_expected;
                f.evidence = synthesized;
            }
            const id = f.fix_id || f.code;
            transparencyPhysicalEvidence[id] = f.evidence;

            if (f.evidence.rendering_safety_proven === true) physicalRenderingSafetyProven = true;
            if (f.evidence.visual_change_expected === true) physicalVisualChangeExpected = true;
        });

        const physicalFlattenApplied = appliedTransparencyPhysicalFixes.length > 0;
        const transparencyOverprintPhysicalGovernanceHasRisks = allTransparencyPhysicalFixes.length > 0;

        if (transparencyOverprintPhysicalGovernanceHasRisks) {
            transparencyPhysicalWarnings.push("Transparency/overprint physical changes (flattening, blend mode normalization, overprint simulation) always require visual review.");
            allTransparencyPhysicalFixes.forEach(f => {
                const id = f.fix_id || f.code;
                if (!transparencyPhysicalReviewReasons.includes(id)) transparencyPhysicalReviewReasons.push(id);
            });
        }

        if (physicalFlattenApplied) {
            transparencyPhysicalWarnings.push("Physical flattening was applied. rendering_safety_proven=false until visual review confirms output.");
        }

        const transparencyOverprintPhysicalGovernance = {
            review_required: true,
            production_certified: false,
            certified_pdf_allowed: false,
            physical_flatten_applied: physicalFlattenApplied,
            physical_flatten_attempted: transparencyOverprintPhysicalGovernanceHasRisks,
            flatten_transparency_applied: appliedTransparencyPhysicalFixes.some(f => (f.fix_id || f.code) === 'FLATTEN_TRANSPARENCY'),
            normalize_blend_modes_applied: appliedTransparencyPhysicalFixes.some(f => (f.fix_id || f.code) === 'NORMALIZE_BLEND_MODES'),
            flatten_overprint_applied: appliedTransparencyPhysicalFixes.some(f => (f.fix_id || f.code) === 'FLATTEN_OVERPRINT'),
            simulate_overprint_preview_applied: appliedTransparencyPhysicalFixes.some(f => (f.fix_id || f.code) === 'SIMULATE_OVERPRINT_PREVIEW'),
            rendering_safety_proven: physicalRenderingSafetyProven,
            visual_change_expected: physicalVisualChangeExpected || physicalFlattenApplied,
            standard_certified: false,
            pdfx_compliance_claimed: false,
            pdfa_compliance_claimed: false,
            compliance_claim_allowed: false,
            review_required_reasons: transparencyPhysicalReviewReasons,
            warnings: transparencyPhysicalWarnings,
            evidence: transparencyPhysicalEvidence
        };

        if (transparencyOverprintPhysicalGovernanceHasRisks) {
            requiresReviewPolicy = true;
            productionCertified = false;
            standardCertified = false;
            pdfxComplianceClaimed = false;
            pdfaComplianceClaimed = false;
            complianceClaimAllowed = false;
            transparencyPhysicalReviewReasons.forEach(r => {
                if (!reviewRequiredReasons.includes(r)) reviewRequiredReasons.push(r);
            });
        }

        // --- Phase 56B: Artifact Trust Policy Evaluation ---
        let operatorApproved = data.operator_approved === true || input?.operator_approved === true || payload?.operator_approved === true;
        let blockedDomains = [];
        if (colorGovernanceHasRisks) blockedDomains.push('color');
        if (transparencyGovernanceHasRisks) blockedDomains.push('transparency_overprint');
        if (imageGovernanceHasRisks) blockedDomains.push('image_quality');
        if (standardsGovernanceHasRisks) blockedDomains.push('standards_certification');
        if (pageMarksGovernanceHasRisks) blockedDomains.push('page_marks');
        if (securityInteractivityGovernanceHasRisks) blockedDomains.push('security_interactivity');
        if (inkGovernanceHasRisks) blockedDomains.push('ink_governance');
        if (selectiveImageGovernanceHasRisks) blockedDomains.push('selective_image_governance');
        if (fontGovernanceHasRisks) blockedDomains.push('font_governance');
        if (transparencyOverprintPhysicalGovernanceHasRisks) blockedDomains.push('transparency_overprint_physical_governance');

        let artifactTrust = {
            trust_level: "RAW_INPUT",
            primary_artifact_type: null,
            primary_artifact_filename: null,
            review_required: requiresReviewPolicy,
            production_certified: productionCertified,
            standard_certified: standardCertified,
            customer_visible: false,
            certified_pdf_allowed: false,
            pdfx_compliance_claimed: pdfxComplianceClaimed,
            pdfa_compliance_claimed: pdfaComplianceClaimed,
            compliance_claim_allowed: complianceClaimAllowed,
            blocked_by_governance_domains: blockedDomains,
            primary_disallowed_reasons: [],
            certification_labels: [],
            warnings: [],
            evidence: {}
        };

        if (operatorApproved) {
            let visualOnly = blockedDomains.every(d => ['color', 'transparency_overprint', 'image_quality'].includes(d));
            if (visualOnly) {
                artifactTrust.review_required = false;
                artifactTrust.production_certified = true;
                artifactTrust.blocked_by_governance_domains = [];
                artifactTrust.evidence.operator_approval_applied = true;
            } else {
                artifactTrust.evidence.operator_approval_ignored = true;
                artifactTrust.warnings.push("Operator approval ignored: standards governance or non-visual blockers active.");
            }
        }

        if (artifactTrust.blocked_by_governance_domains.length > 0) {
            artifactTrust.review_required = true;
            artifactTrust.production_certified = false;
        }

        if (artifactTrust.review_required) {
            artifactTrust.trust_level = "FIXED_REVIEW_REQUIRED";
            artifactTrust.certified_pdf_allowed = false;
        } else if (artifactTrust.standard_certified && artifactTrust.production_certified) {
            artifactTrust.trust_level = "STANDARD_CERTIFIED";
            artifactTrust.certified_pdf_allowed = true;
        } else if (artifactTrust.production_certified) {
            artifactTrust.trust_level = "PRODUCTION_CERTIFIED";
            artifactTrust.certified_pdf_allowed = true;
        } else {
            artifactTrust.trust_level = "FIXED_READY";
            artifactTrust.certified_pdf_allowed = false;
        }

        if (outputintentOnly || outputintentDoesNotProvePdfx) {
            artifactTrust.warnings.push("OutputIntent injection alone does not prove PDF/X compliance.");
        }

        // We defer primary_artifact selection until we verify physical artifacts
        // Update variables based on artifact_trust policy
        requiresReviewPolicy = artifactTrust.review_required;
        productionCertified = artifactTrust.production_certified;


        logger.info({
            jobId,
            tenantId,
            applied_fixes_count: appliedFixes.length,
            skipped_fixes_count: skippedFixes.length,
            failed_fixes_count: failedFixes.length,
            requested_fixes: requestedFixes
        }, '[PREFLIGHT-WORKER][FIX_APPLIED]');

        // Instrumentation 4: [WORKER][AUTOFIX][ENGINE-RESULT]
        logger.info({
            jobId,
            fixJobId: jobId,
            sourceJobId,
            requestedFixesCount: requestedFixes.length,
            requestedFixes,
            sourceFindingsCount: sourceFindings ? sourceFindings.length : 0,
            engineRepairsCount: allRepairs.length,
            engineRepairs: allRepairs.map(r => ({ code: r?.code, status: r?.status })),
            storedRepairsCount: allRepairs.length,
            storedRepairs: allRepairs.map(r => ({ code: r?.code, status: r?.status })),
            artifacts: [],
            artifactNames: {},
            forceBleed,
            targetProfile
        }, '[WORKER][AUTOFIX][ENGINE-RESULT] Preserved complete engine output without filtering');

        if (result?.ok === false && allRepairs.length === 0 && !result?.status && !result?.fixedPath) {
            logger.error({ jobId, error: result.error }, '[WORKER][AUTOFIX][GS-FAIL]');
            throw new Error(`[AUTOFIX-ENGINE-ERROR] jobId=${jobId} Engine failed: ${result.error}`);
        }

        if (job.updateProgress) await job.updateProgress(90);

        // Phase 5: Evidence Artifacts (Shape Unified for Phase 10)
        logger.info({ jobId, outputDir }, '[WORKER][AUTOFIX][SEARCHING-ARTIFACTS]');

        let bestSource = null;

        // 1. Priority: Explicit fixedPath
        if (result?.fixedPath) {
            logger.info({ jobId, path: result.fixedPath }, '[WORKER][AUTOFIX][ENGINE-FIXED-PATH]');
            if (await fs.pathExists(result.fixedPath)) {
                bestSource = result.fixedPath;
            }
        }

        // 2. Priority: Structured artifacts path
        if (!bestSource && result?.artifacts?.fixed_pdf?.path) {
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

        logger.info({ jobId, tenantId, outputDir }, '[PREFLIGHT-WORKER][ARTIFACT_WRITE_START]');

        const certifiedPath = `${outputDir}/certified.pdf`;
        const fixedPdfPath = `${outputDir}/fixed.pdf`;
        const verifiedArtifacts = {};
        let physicalArtifactsReady = false;
        let zeroByteArtifactCount = 0;
        let downloadableArtifactCount = 0;

        const artifactClient = new ControlPlaneArtifacts({
            url: process.env.CONTROL_PLANE_URL,
            token: process.env.PPOS_CONTROL_TOKEN,
            workerId: process.env.WORKER_ID || `worker-${os.hostname()}`
        }, logger);

        const requiresReview = requiresReviewPolicy;
        const createCertifiedPdf = artifactTrust.certified_pdf_allowed;
        
        if (requiresReview) {
            logger.info({ jobId }, '[PREFLIGHT-WORKER][REVIEW_REQUIRED_ARTIFACT_POLICY]');
            logger.info({ jobId }, '[PREFLIGHT-WORKER][CERTIFIED_ARTIFACT_SUPPRESSED_REVIEW_REQUIRED]');
        }
        if (createCertifiedPdf) {
            logger.info({ jobId }, '[PREFLIGHT-WORKER][CERTIFIED_ARTIFACT_READY]');
        }

        if (bestSource) {
            // v2.4.120: Certification Suffix Promotion
            if (bestSource !== certifiedPath) {
                await fs.copy(bestSource, certifiedPath, { overwrite: true });
            }
            if (bestSource !== fixedPdfPath) {
                await fs.copy(bestSource, fixedPdfPath, { overwrite: true });
            }

            // Register with Control Plane
            const registerArtifact = async (type, filePath, name, extraMetadata = {}) => {
                try {
                    const stats = await fs.stat(filePath);
                    if (stats.size <= 0) {
                        logger.warn({ jobId, type, filePath, sizeBytes: stats.size }, '[PREFLIGHT-WORKER][ZERO_BYTE_ARTIFACT_BLOCKED]');
                        zeroByteArtifactCount++;
                        return false;
                    }
                    
                    let checksumSha256 = null;
                    try {
                        checksumSha256 = await sha256File(filePath);
                    } catch (hashError) {
                        logger.warn({ jobId, type, error: hashError.message }, '[WORKER][ARTIFACT][SHA256][WARN]');
                    }

                    const meta = { 
                        processor: "AUTOFIX", 
                        artifact_type: type,
                        filename: name,
                        size_bytes: stats.size,
                        checksum_sha256: checksumSha256,
                        mime_type: type.endsWith('pdf') ? 'application/pdf' : 'application/json',
                        downloadable: true,
                        requires_review: !!extraMetadata.requires_review,
                        production_certified: !!extraMetadata.production_certified,
                        source_fix_ids: appliedFixes.map(f => f.fix_id || f.code),
                        risk_level: appliedFixes.some(f => f.risk_level === 'CRITICAL' || f.risk_level === 'HIGH') ? 'HIGH' : 'LOW',
                        customer_visible: true,
                        ...extraMetadata 
                    };

                    await artifactClient.register({
                        jobId,
                        tenantId,
                        artifactType: type,
                        filename: name,
                        storageKey: filePath,
                        sizeBytes: stats.size,
                        checksumSha256,
                        mimeType: type.endsWith('pdf') ? 'application/pdf' : 'application/json',
                        metadata: meta,
                        downloadable: true
                    });
                    
                    logger.info({ jobId, type, filePath, sizeBytes: stats.size }, '[PREFLIGHT-WORKER][ARTIFACT_WRITE_OK]');
                    downloadableArtifactCount++;
                    return true;
                } catch (e) {
                    logger.warn({ error: e.message, type, filePath }, '[PREFLIGHT-WORKER][ARTIFACT_WRITE_FAILED]');
                    return false;
                }
            };

            const fixedRegistered = await registerArtifact('fixed_pdf', fixedPdfPath, 'fixed.pdf', { requires_review: requiresReview });
            if (fixedRegistered) {
                verifiedArtifacts.fixed_pdf = 'fixed.pdf';
                verifiedArtifacts.final_fixed_pdf = 'fixed.pdf';
                physicalArtifactsReady = true;
                
                // If requires review, also alias review_pdf to the same file
                if (requiresReview) {
                    await registerArtifact('review_pdf', fixedPdfPath, 'fixed.pdf', { requires_review: true });
                    verifiedArtifacts.review_pdf = 'fixed.pdf';
                }
                
                if (createCertifiedPdf) {
                    await registerArtifact('certified_pdf', certifiedPath, 'certified.pdf', { production_certified: true });
                    verifiedArtifacts.certified_pdf = 'certified.pdf';
                }
            }
        }

        // Primary Artifact Selection (Phase 56B)
        if (!physicalArtifactsReady) {
            artifactTrust.primary_artifact_type = null;
            artifactTrust.customer_visible = false;
            artifactTrust.primary_disallowed_reasons.push("NO_SAFE_ARTIFACT");
            artifactTrust.evidence.primary_selection_reason = "No physical artifacts generated.";
        } else {
            if (artifactTrust.review_required) {
                if (verifiedArtifacts.review_pdf) {
                    artifactTrust.primary_artifact_type = "review_pdf";
                    artifactTrust.primary_artifact_filename = verifiedArtifacts.review_pdf;
                } else {
                    artifactTrust.primary_artifact_type = "fixed_pdf";
                    artifactTrust.primary_artifact_filename = verifiedArtifacts.fixed_pdf;
                }
                artifactTrust.customer_visible = false;
                artifactTrust.evidence.primary_selection_reason = "Review required.";
                if (verifiedArtifacts.certified_pdf) {
                    artifactTrust.primary_disallowed_reasons.push("certified_pdf blocked by review_required");
                }
            } else if (artifactTrust.standard_certified) {
                artifactTrust.primary_artifact_type = verifiedArtifacts.certified_pdf ? "certified_pdf" : "fixed_pdf";
                artifactTrust.primary_artifact_filename = verifiedArtifacts.certified_pdf || verifiedArtifacts.fixed_pdf;
                artifactTrust.customer_visible = true;
                if (standardDetected) artifactTrust.certification_labels.push(standardDetected);
                artifactTrust.evidence.primary_selection_reason = "Standard certified.";
            } else if (artifactTrust.production_certified) {
                artifactTrust.primary_artifact_type = verifiedArtifacts.certified_pdf ? "certified_pdf" : "fixed_pdf";
                artifactTrust.primary_artifact_filename = verifiedArtifacts.certified_pdf || verifiedArtifacts.fixed_pdf;
                artifactTrust.customer_visible = true;
                artifactTrust.evidence.primary_selection_reason = "Production certified internally.";
            } else {
                artifactTrust.primary_artifact_type = "fixed_pdf";
                artifactTrust.primary_artifact_filename = verifiedArtifacts.fixed_pdf;
                artifactTrust.customer_visible = false;
                artifactTrust.primary_disallowed_reasons.push("Not production certified.");
                artifactTrust.evidence.primary_selection_reason = "Fallback to fixed_pdf due to lack of certification.";
            }
        }

        // Enforce customer_visible stricter than production_certified
        if (artifactTrust.review_required || !artifactTrust.production_certified || artifactTrust.blocked_by_governance_domains.length > 0) {
            artifactTrust.customer_visible = false;
        }

        // Materialize fix_audit.json
        logger.info({ jobId }, '[PREFLIGHT-WORKER][FIX_AUDIT_V2_WRITE_START]');
        const auditReportPath = `${outputDir}/fix_audit.json`;
        const auditData = {
            version: "2.0",
            job_id: jobId,
            parent_job_id: sourceJobId,
            source_pdf: fileUrl,
            engine_version: "2.5.0",
            policy_mode: requiresReviewPolicy ? "REVIEW_REQUIRED" : (productionCertified ? "SAFE" : "EXPERIMENTAL"),
            requested_fixes: requestedFixes,
            applied_fixes: appliedFixes,
            skipped_fixes: skippedFixes,
            failed_fixes: failedFixes,
            fix_results: fixResults,
            review_required: requiresReviewPolicy,
            review_required_reasons: reviewRequiredReasons,
            production_certified: productionCertified,
            artifact_policy: {
                fixed_pdf: physicalArtifactsReady,
                review_pdf: requiresReviewPolicy && physicalArtifactsReady,
                certified_pdf: createCertifiedPdf && physicalArtifactsReady,
                delta_report: true
            },
            artifact_trust: artifactTrust,
            standards_certification_governance: {
                review_required: standardsGovernanceHasRisks,
                production_certified: !standardsGovernanceHasRisks && productionCertified,
                certified_pdf_allowed: !standardsGovernanceHasRisks && createCertifiedPdf && physicalArtifactsReady,
                standard_certified: standardCertified,
                pdfx_compliance_claimed: pdfxComplianceClaimed,
                pdfa_compliance_claimed: pdfaComplianceClaimed,
                standard_claimed: standardClaimed,
                validator_required: validatorRequired,
                validator_available: validatorAvailable,
                validation_performed: validationPerformed,
                validation_passed: validationPassed,
                validator_name: validatorName,
                validator_version: validatorVersion,
                validation_report_available: validationReportAvailable,
                compliance_claim_allowed: complianceClaimAllowed,
                outputintent_only: outputintentOnly,
                outputintent_does_not_prove_pdfx: outputintentDoesNotProvePdfx,
                unsupported_standards_fixes: unsupportedStandardsFixes,
                review_required_reasons: standardsReviewReasons,
                detector_gap: detectorGap,
                fixture_gap: fixtureGap,
                validator_gap: validatorGap,
                deferred: deferredGap
            },
            structural_metadata_governance: structuralMetadataGovernance,
            page_marks_governance: pageMarksGovernance,
            security_interactivity_governance: securityInteractivityGovernance,
            ink_governance: inkGovernance,
            selective_image_governance: selectiveImageGovernance,
            font_governance: fontGovernance,
            transparency_overprint_physical_governance: transparencyOverprintPhysicalGovernance,
            toolchain: toolchain,
            created_at: new Date().toISOString()
        };
        await fs.writeJson(auditReportPath, auditData, { spaces: 2 });
        logger.info({ jobId }, '[PREFLIGHT-WORKER][FIX_AUDIT_V2_WRITE_OK]');
        
        try {
            const stats = await fs.stat(auditReportPath);
            if (stats.size > 0) {
                let auditChecksum = null;
                try { auditChecksum = await sha256File(auditReportPath); } catch(e){}
                
                await artifactClient.register({
                    jobId, tenantId, artifactType: 'fix_audit', filename: 'fix_audit.json',
                    storageKey: auditReportPath, sizeBytes: stats.size, checksumSha256: auditChecksum,
                    mimeType: 'application/json',
                    metadata: { 
                        processor: "AUTOFIX", artifact_type: 'fix_audit', filename: 'fix_audit.json',
                        size_bytes: stats.size, checksum_sha256: auditChecksum, mime_type: 'application/json',
                        downloadable: true, requires_review: false, production_certified: false,
                        source_fix_ids: [], risk_level: 'LOW', customer_visible: false
                    }, 
                    downloadable: true
                });
                logger.info({ jobId, type: 'fix_audit', filePath: auditReportPath, sizeBytes: stats.size }, '[PREFLIGHT-WORKER][ARTIFACT_WRITE_OK]');
                verifiedArtifacts.fix_audit = 'fix_audit.json';
                downloadableArtifactCount++;
            } else {
                logger.warn({ jobId, type: 'fix_audit', filePath: auditReportPath, sizeBytes: stats.size }, '[PREFLIGHT-WORKER][ZERO_BYTE_ARTIFACT_BLOCKED]');
                zeroByteArtifactCount++;
            }
        } catch (e) {
            logger.warn({ error: e.message, type: 'fix_audit' }, '[PREFLIGHT-WORKER][ARTIFACT_WRITE_FAILED]');
        }

        // Materialize delta_report.json
        const deltaReportPath = `${outputDir}/delta_report.json`;
        const deltaData = {
            job_id: jobId,
            changes: appliedFixes.map(f => f.fix_id || f.code),
            boxes_changed: appliedFixes.filter(f => ['REBUILD_TRIMBOX', 'APPLY_BLEED'].includes(f.fix_id || f.code)).map(f => f.fix_id || f.code),
            color_converted: appliedFixes.some(f => f.fix_id === 'CONVERT_CMYK' || f.code === 'CONVERT_CMYK'),
            interactive_removed: appliedFixes.some(f => ['FLATTEN_INTERACTIVE', 'STRIP_JAVASCRIPT', 'FLATTEN_ANNOTATIONS', 'FLATTEN_FORMS'].includes(f.fix_id || f.code)),
            skipped_fixes: skippedFixes.map(f => ({ fix_id: f.fix_id || f.code, reason: f.reason })),
            visual_review_required: requiresReviewPolicy,
            color_governance: {
                highest_color_risk: colorGovernanceHasRisks ? 'HIGH' : 'LOW',
                destructive_color_fix_applied: hasConvertCmyk,
                unsupported_color_fixes: requestedUnsupportedColorFixes.map(f => f.fix_id || f.code),
                review_required_color_reasons: colorReviewReasons,
                production_certified: productionCertified,
                certified_pdf_allowed: createCertifiedPdf && physicalArtifactsReady
            },
            transparency_overprint_governance: {
                review_required: transparencyGovernanceHasRisks,
                production_certified: !transparencyGovernanceHasRisks && productionCertified,
                certified_pdf_allowed: !transparencyGovernanceHasRisks && createCertifiedPdf && physicalArtifactsReady,
                highest_transparency_overprint_risk: highestTransparencyRisk,
                visual_rewrite_fix_applied: appliedVisualRewriteFix.length > 0,
                unsupported_transparency_overprint_fixes: requestedUnsupportedTransparencyFixes.map(f => f.fix_id || f.code),
                review_required_reasons: transparencyReviewReasons,
                transparency_present: transparencyPresent,
                overprint_present: overprintPresent,
                soft_masks_present: softMasksPresent,
                blend_modes_present: blendModesPresent,
                rasterization_risk: rasterizationRisk,
                pdfx_compliance_claimed: pdfxComplianceClaimed
            },
            image_quality_governance: {
                review_required: imageGovernanceHasRisks,
                production_certified: !imageGovernanceHasRisks && productionCertified,
                certified_pdf_allowed: !imageGovernanceHasRisks && createCertifiedPdf && physicalArtifactsReady,
                highest_image_quality_risk: highestImageRisk === 'LOW' ? null : highestImageRisk,
                visual_image_rewrite_applied: appliedVisualImageRewriteFix.length > 0,
                unsupported_image_quality_fixes: requestedUnsupportedImageFixes.map(f => f.fix_id || f.code),
                review_required_reasons: imageReviewReasons,
                low_res_images_present: lowResImagesPresent,
                excessive_resolution_present: excessiveResolutionPresent,
                jpeg_artifacts_present: jpegArtifactsPresent,
                image_replacement_required: imageReplacementRequired,
                bitmap_text_risk: bitmapTextRisk,
                rasterized_vector_risk: rasterizedVectorRisk,
                image_object_damaged: imageObjectDamaged,
                image_rewrite_performed: appliedVisualImageRewriteFix.length > 0
            },
            standards_certification_governance: {
                review_required: standardsGovernanceHasRisks,
                production_certified: !standardsGovernanceHasRisks && productionCertified,
                certified_pdf_allowed: !standardsGovernanceHasRisks && createCertifiedPdf && physicalArtifactsReady,
                standard_certified: standardCertified,
                pdfx_compliance_claimed: pdfxComplianceClaimed,
                pdfa_compliance_claimed: pdfaComplianceClaimed,
                standard_claimed: standardClaimed,
                validator_required: validatorRequired,
                validator_available: validatorAvailable,
                validation_performed: validationPerformed,
                validation_passed: validationPassed,
                validator_name: validatorName,
                validator_version: validatorVersion,
                validation_report_available: validationReportAvailable,
                compliance_claim_allowed: complianceClaimAllowed,
                outputintent_only: outputintentOnly,
                outputintent_does_not_prove_pdfx: outputintentDoesNotProvePdfx,
                unsupported_standards_fixes: unsupportedStandardsFixes,
                review_required_reasons: standardsReviewReasons,
                detector_gap: detectorGap,
                fixture_gap: fixtureGap,
                validator_gap: validatorGap,
                deferred: deferredGap
            },
            structural_metadata_governance: structuralMetadataGovernance,
            page_marks_governance: pageMarksGovernance,
            security_interactivity_governance: securityInteractivityGovernance,
            ink_governance: inkGovernance,
            selective_image_governance: selectiveImageGovernance,
            font_governance: fontGovernance,
            transparency_overprint_physical_governance: transparencyOverprintPhysicalGovernance,
            artifact_trust: artifactTrust
        };
        await fs.writeJson(deltaReportPath, deltaData, { spaces: 2 });
        try {
            const stats = await fs.stat(deltaReportPath);
            if (stats.size > 0) {
                let checksumSha256 = null;
                try { checksumSha256 = await sha256File(deltaReportPath); } catch (e) {}
                await artifactClient.register({
                    jobId, tenantId, artifactType: 'delta_report', filename: 'delta_report.json',
                    storageKey: deltaReportPath, sizeBytes: stats.size, checksumSha256,
                    mimeType: 'application/json', 
                    metadata: { 
                        processor: "AUTOFIX", artifact_type: 'delta_report', filename: 'delta_report.json',
                        size_bytes: stats.size, checksum_sha256: checksumSha256, mime_type: 'application/json',
                        downloadable: true, requires_review: false, production_certified: false,
                        source_fix_ids: [], risk_level: 'LOW', customer_visible: false
                    }, 
                    downloadable: true
                });
                logger.info({ jobId }, '[PREFLIGHT-WORKER][DELTA_REPORT_WRITE_OK]');
                verifiedArtifacts.delta_report = 'delta_report.json';
                downloadableArtifactCount++;
            } else {
                logger.warn({ jobId, type: 'delta_report', filePath: deltaReportPath, sizeBytes: stats.size }, '[PREFLIGHT-WORKER][ZERO_BYTE_ARTIFACT_BLOCKED]');
                zeroByteArtifactCount++;
            }
        } catch (e) {
            logger.warn({ error: e.message, type: 'delta_report' }, '[PREFLIGHT-WORKER][ARTIFACT_WRITE_FAILED]');
        }

        if (job.updateProgress) await job.updateProgress(100);

        logger.info({
            jobId, tenantId, 
            artifact_count: Object.keys(verifiedArtifacts).length,
            downloadable_artifact_count: downloadableArtifactCount,
            zero_byte_artifact_count: zeroByteArtifactCount
        }, '[PREFLIGHT-WORKER][AUTOFIX_COMPLETE]');

        if (!physicalArtifactsReady) {
            logger.warn({ jobId }, '[WORKER][AUTOFIX][NO-OUTPUT-BYTES]');
            return {
                status: 'FAILED',
                type: 'AUTOFIX',
                sourceJobId: sourceJobId || null,
                requested_fixes: requestedFixes,
                repairs: allRepairs,
                fixes: allRepairs,
                applied_fixes: appliedFixes,
                skipped_fixes: skippedFixes,
                failed_fixes: failedFixes,
                report: result,
                artifacts: [],
                physical_artifacts_ready: false,
                artifact_error: 'NO_FIXED_PDF_BYTES_PRODUCED',
                tenantId,
                jobId,
                processedAt: new Date().toISOString()
            };
        }

        const finalArtifacts = {
            ...verifiedArtifacts,
            final_fixed_pdf: verifiedArtifacts.final_fixed_pdf || verifiedArtifacts.fixed_pdf || 'fixed.pdf'
        };

        // Instrumentation 5: [WORKER][AUTOFIX][RESULT-STORED]
        logger.info({
            jobId,
            fixJobId: jobId,
            sourceJobId,
            requestedFixesCount: requestedFixes.length,
            requestedFixes,
            sourceFindingsCount: sourceFindings ? sourceFindings.length : 0,
            engineRepairsCount: allRepairs.length,
            engineRepairs: allRepairs.map(r => ({ code: r?.code, status: r?.status })),
            storedRepairsCount: allRepairs.length,
            storedRepairs: allRepairs.map(r => ({ code: r?.code, status: r?.status })),
            artifacts: Object.keys(finalArtifacts),
            artifactNames: finalArtifacts,
            forceBleed,
            targetProfile
        }, '[WORKER][AUTOFIX][RESULT-STORED] Final end-to-end autofix result stored');

        const finalStatus = !hasSourceFindings ? 'DEGRADED' : 'COMPLETED';

        return {
            status: finalStatus,
            ...(!hasSourceFindings ? { reason: 'MISSING_SOURCE_FINDINGS_FOR_AUTOFIX' } : {}),
            type: 'AUTOFIX',
            sourceJobId: sourceJobId || null,
            requested_fixes: requestedFixes,
            repairs: allRepairs,
            fixes: allRepairs,
            applied_fixes: appliedFixes,
            skipped_fixes: skippedFixes,
            failed_fixes: failedFixes,
            report: result,
            artifacts: finalArtifacts,
            tenantId,
            jobId,
            processedAt: new Date().toISOString()
        };
    }
}

module.exports = AutofixProcessor;
