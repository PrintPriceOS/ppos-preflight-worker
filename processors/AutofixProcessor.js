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
        const createCertifiedPdf = productionCertified && !hasCriticalFailed && !requiresReview;
        
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
            }
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
