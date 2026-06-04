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
        const appliedFixes = allRepairs.filter(r => r?.status === 'APPLIED');
        const skippedFixes = allRepairs.filter(r => r?.status === 'SKIPPED');
        const failedFixes = allRepairs.filter(r => r?.status === 'FAILED' || r?.status === 'UNSUPPORTED');

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

        const requiresReview = failedFixes.length > 0 || result?.status === 'REVIEW_REQUIRED';

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

                    const meta = { processor: "AUTOFIX", ...extraMetadata };

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
                
                await registerArtifact('certified_pdf', certifiedPath, 'certified.pdf');
                verifiedArtifacts.certified_pdf = 'certified.pdf';
            }
        }

        // Materialize fix_audit.json
        const auditReportPath = `${outputDir}/fix_audit.json`;
        const auditData = {
            job_id: jobId,
            parent_job_id: sourceJobId,
            tenant_id: tenantId,
            requested_fixes: requestedFixes,
            applied_fixes: appliedFixes,
            skipped_fixes: skippedFixes,
            failed_fixes: failedFixes,
            result_status: result?.status || 'COMPLETED',
            created_at: new Date().toISOString(),
            source_pdf_resolution: 'RESOLVED',
            artifact_error: physicalArtifactsReady ? null : 'NO_FIXED_PDF_BYTES_PRODUCED'
        };
        await fs.writeJson(auditReportPath, auditData, { spaces: 2 });
        
        try {
            const stats = await fs.stat(auditReportPath);
            if (stats.size > 0) {
                let auditChecksum = null;
                try { auditChecksum = await sha256File(auditReportPath); } catch(e){}
                
                await artifactClient.register({
                    jobId, tenantId, artifactType: 'fix_audit', filename: 'fix_audit.json',
                    storageKey: auditReportPath, sizeBytes: stats.size, checksumSha256: auditChecksum,
                    mimeType: 'application/json', metadata: { processor: "AUTOFIX" }, downloadable: true
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
