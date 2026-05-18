/**
 * AnalyzeProcessor
 * 
 * Invokes the Engine for PDF analysis.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');

const StorageManager = require('../utils/StorageManager');
const ControlPlaneArtifacts = require('../utils/ControlPlaneArtifacts');
const os = require('os');
const { sha256File } = require('../utils/fileChecksum');
const classifyEngineResult = require('../utils/classifyEngineResult');

// Canonical storage instance
const storage = new StorageManager();

function collectAndDeduplicateFindings(report) {
    if (!report) return [];
    
    const list = [];
    const addAll = (arr) => {
        if (Array.isArray(arr)) {
            list.push(...arr);
        }
    };

    addAll(report.findings);
    addAll(report.issues);
    if (report.analysis) {
        addAll(report.analysis.findings);
        addAll(report.analysis.issues);
    }
    if (report.forensics) {
        addAll(report.forensics.findings);
    }

    const unique = [];
    const seenIds = new Set();
    const seenCompositeKeys = new Set();

    for (const f of list) {
        if (!f) continue;
        
        const id = f.id;
        const code = f.code || '';
        const page = f.page !== undefined && f.page !== null ? String(f.page) : '';
        const severity = (f.severity || '').toLowerCase();
        const message = f.message || '';
        
        if (id !== undefined && id !== null && id !== '') {
            if (!seenIds.has(id)) {
                seenIds.add(id);
                unique.push(f);
            }
        } else {
            const composite = `${code}|${page}|${severity}|${message}`;
            if (!seenCompositeKeys.has(composite)) {
                seenCompositeKeys.add(composite);
                unique.push(f);
            }
        }
    }
    
    return unique;
}

class AnalyzeProcessor {
    static async process(job, logger = console) {
        const data = job?.data || {};
        const { jobId, tenantId, deploymentId, tenantIsolation, payload, input, trace = {} } = data;
        
        await job.updateProgress(10); // Phase 1: Ingest complete
        
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
        
        await job.updateProgress(30); // Phase 2: Starting engine analyze
        
        const engine = createStandardEngine();
        
        // --- v2.4.88: Engine Safety Wrapper (Timeout + Logging) ---
        const withTimeout = (promise, ms) => {
            return Promise.race([
                promise,
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('ENGINE_TIMEOUT_EXCEEDED')), ms)
                )
            ]);
        };

        logger.info({ jobId, filePath }, 'ENGINE_ANALYSIS_START');
        
        let report;
        try {
            report = await withTimeout(
                engine.analyzePdf(filePath, {
                    ...options,
                    outputDir,
                    tempDir,
                    tenantId
                }),
                600000 // 10 Minutes hard limit for 19MB+ PDFs
            );
            logger.info({ jobId }, 'ENGINE_ANALYSIS_END');
        } catch (err) {
            logger.error({ jobId, error: err.message }, 'ENGINE_ANALYSIS_CRITICAL_FAILURE');
            throw err;
        }
        // -----------------------------------------------------------

        // Non-destructive metadata preservation for Phase 10 compliance
        if (report && report.analysisIntegrity) {
            const missing = report.analysisIntegrity.missingTools || [];
            if (missing.length > 0 || report.analysis_type === 'DEGRADED') {
                logger.info({ jobId, missing }, '[WORKER][TOOLS][INFO] Preserving engine-provided analysisIntegrity while recording worker-observed state.');
                report.analysisIntegrity.workerObservedMissingTools = missing;
                report.analysisIntegrity.workerDegradedMode = true;
            }
        }

        await job.updateProgress(70); // Phase 3: Engine returned report
        
        await job.updateProgress(95); // Phase 4: Finalizing report persistence
        
        const fs = require('fs-extra');
        const path = require('path');
        
        // Always write report.json in Phase 10
        const reportPath = path.join(outputDir, 'report.json');
        const enrichedReport = {
            ...report,
            jobId,
            tenantId,
            processedAt: new Date().toISOString(),
            workerId: process.env.WORKER_ID || `worker-${os.hostname()}`,
            contractMode
        };
        await fs.writeJson(reportPath, enrichedReport, { spaces: 2 });
        logger.info({ jobId, path: reportPath }, '[WORKER][ANALYZE][REPORT-WRITTEN] Wrote report.json to disk');

        // Collect findings from all possible locations and deduplicate
        const findings = collectAndDeduplicateFindings(report);

        // Enrich report with the unified findings so that the classifier works on all findings
        const enrichedReportForClassifier = {
            ...report,
            findings,
            issues: findings
        };

        // Canonical Phase 10 Result Classification
        const classifier = classifyEngineResult(enrichedReportForClassifier);
        
        const warnings = report?.warnings || [];
        const analyzerCoverage = report?.analyzerCoverage || report?.analyzer_coverage || {};
        const analyzer_coverage = report?.analyzer_coverage || report?.analyzerCoverage || {};
        const analysisIntegrity = report?.analysisIntegrity || {};
        const summary = report?.summary || {};

        const hasBlockingFindings = findings.some(f => {
            const sev = (f.severity || '').toLowerCase();
            return sev === 'critical' || sev === 'error';
        });

        // Gating certification based on findings severity and report certifiability
        const shouldCertify = (
            classifier !== 'FULL_ENVIRONMENT_FAILURE' &&
            classifier !== 'DOCUMENT_FAILURE' &&
            report?.certifiable !== false &&
            analysisIntegrity?.certifiable !== false &&
            !hasBlockingFindings
        );

        logger.info({ jobId, classifier, shouldCertify }, '[WORKER][ANALYZE][CLASSIFY] Classified engine report');

        const artifacts = {
            analysis_report: 'report.json'
        };

        const artifactClient = new ControlPlaneArtifacts({
            url: process.env.CONTROL_PLANE_URL,
            token: process.env.PPOS_CONTROL_TOKEN,
            workerId: process.env.WORKER_ID || `worker-${os.hostname()}`
        }, logger);

        // 1. Register report.json with Control Plane
        try {
            const reportStats = await fs.stat(reportPath);
            let reportChecksum = null;
            try {
                reportChecksum = await sha256File(reportPath);
                logger.info({ jobId, type: 'analysis_report', checksumSha256: reportChecksum }, '[WORKER][ARTIFACT][SHA256][OK]');
            } catch (hashError) {
                logger.warn({ jobId, type: 'analysis_report', error: hashError.message }, '[WORKER][ARTIFACT][SHA256][WARN]');
            }

            await artifactClient.register({
                jobId,
                tenantId,
                artifactType: 'analysis_report',
                filename: 'report.json',
                storageKey: reportPath,
                sizeBytes: reportStats.size,
                checksumSha256: reportChecksum,
                mimeType: 'application/json',
                metadata: {
                    processor: "ANALYZE"
                }
            });
        } catch (e) {
            logger.warn({ error: e.message }, '[WORKER][CONTROL-PLANE-ARTIFACT][WARN] Failed to register report.json');
        }

        // 2. Conditionally copy and register certified.pdf
        if (shouldCertify) {
            const certifiedPath = path.join(outputDir, 'certified.pdf');
            if (filePath && await fs.pathExists(filePath)) {
                if (filePath !== certifiedPath) {
                    await fs.copy(filePath, certifiedPath, { overwrite: true });
                }
                logger.info({ jobId, artifact: 'certified_pdf' }, '[WORKER][ANALYZE][ARTIFACT-REGISTERED] promoted certified.pdf');
                artifacts.certified_pdf = 'certified.pdf';

                try {
                    const stats = await fs.stat(certifiedPath);
                    let checksumSha256 = null;
                    try {
                        checksumSha256 = await sha256File(certifiedPath);
                        logger.info({ jobId, type: 'certified_pdf', checksumSha256 }, '[WORKER][ARTIFACT][SHA256][OK]');
                    } catch (hashError) {
                        logger.warn({ jobId, type: 'certified_pdf', error: hashError.message }, '[WORKER][ARTIFACT][SHA256][WARN]');
                    }

                    await artifactClient.register({
                        jobId,
                        tenantId,
                        artifactType: 'certified_pdf',
                        filename: 'certified.pdf',
                        storageKey: certifiedPath,
                        sizeBytes: stats.size,
                        checksumSha256,
                        mimeType: 'application/pdf',
                        metadata: {
                            processor: "ANALYZE"
                        }
                    });
                } catch (e) {
                    logger.warn({ error: e.message }, '[WORKER][CONTROL-PLANE-ARTIFACT][WARN] Failed to register certified.pdf');
                }
            } else {
                logger.error({ jobId, filePath }, '[WORKER][ANALYZE][NO-SOURCE]');
                throw new Error(`[ANALYZE-FAILURE] jobId=${jobId} Source file not found for artifact promotion.`);
            }
        } else {
            const certifiedPath = path.join(outputDir, 'certified.pdf');
            if (await fs.pathExists(certifiedPath)) {
                await fs.remove(certifiedPath);
            }
            logger.info({ jobId }, '[WORKER][ANALYZE][INFO] Document is not certifiable. Skipping certified.pdf promotion.');
        }

        // Align Worker status semantics
        let finalStatus = 'COMPLETED';
        if (classifier === 'FULL_ENVIRONMENT_FAILURE') {
            finalStatus = 'FAILED';
        } else if (classifier === 'DEGRADED_ANALYSIS') {
            finalStatus = 'DEGRADED';
        } else if (classifier === 'PARTIAL_ANALYSIS') {
            finalStatus = 'PARTIAL';
        } else if (classifier === 'DOCUMENT_FAILURE' || classifier === 'SUCCESS_WITH_FINDINGS') {
            finalStatus = 'COMPLETED_WITH_FINDINGS';
        }

        return {
            status: finalStatus,
            type: 'ANALYZE',
            report,
            findings,
            warnings,
            analyzerCoverage,
            analyzer_coverage,
            analysisIntegrity,
            summary,
            artifacts,
            tenantId,
            jobId,
            processedAt: new Date().toISOString()
        };
    }
}

module.exports = AnalyzeProcessor;
