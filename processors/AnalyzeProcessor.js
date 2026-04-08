/**
 * AnalyzeProcessor
 * 
 * Invokes the Engine for PDF analysis.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');

const StorageManager = require('../utils/StorageManager');
const storage = new StorageManager();

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

        await job.updateProgress(70); // Phase 3: Engine returned report

        /* 
        // ==========================================
        // DYNAMIC MOCK: (DISABLED v2.4.89 - ENABLING REAL ENGINE FINDINGS)
        // ==========================================
        const fs = require('fs');
        let fSize = 0;
        try { fSize = fs.statSync(filePath).size; } catch(e){}

        const allIssues = [
            { id: "IND_GEOM", message: "Geometría/Alineación incorrecta", severity: "error", fixable: true },
            { id: "IND_TYPE", message: "Tipografía Legacy encontrada", severity: "warning", fixable: true },
            { id: "IND_COLOR", message: "Uso de RGB o perfiles no estándar en CMYK", severity: "error", fixable: true },
            { id: "IND_BOX", message: "Inconsistencias en TrimBox/MediaBox", severity: "warning", fixable: false },
            { id: "IND_IMAGE", message: "Imágenes por debajo de los 300 DPI", severity: "error", fixable: false },
            { id: "IND_BLEED", message: "Falta de sangrado / bleed lines", severity: "error", fixable: true },
            { id: "IND_TRIM", message: "Problema con marcas de corte", severity: "warning", fixable: false },
            { id: "IND_FONT", message: "Fuentes no incrustadas", severity: "error", fixable: true },
            { id: "IND_BLACK", message: "Registro excesivo de tinta o negro rico > 320%", severity: "error", fixable: true },
            { id: "IND_SPOT", message: "Colores directos / Pantone no permitidos", severity: "warning", fixable: true },
            { id: "IND_PDF", message: "Versión antigua o no compatible con PDF/X", severity: "error", fixable: false }
        ];

        let issueCount = Math.max(1, (fSize % 5) + 1);
        if (fSize === 0) issueCount = Math.floor(Math.random() * 4) + 1;

        let dynamicIssues = [];
        let score = 100;
        
        for (let i = 0; i < issueCount; i++) {
            let index = fSize === 0 ? Math.floor(Math.random() * allIssues.length) : ((fSize + i * 17) % allIssues.length);
            const baseIssue = allIssues[index];
            if (!dynamicIssues.find(iss => iss.id === baseIssue.id)) {
                dynamicIssues.push({
                    ...baseIssue,
                    page: (i % 3) > 0 ? (i % 3) + 1 : undefined
                });
                score -= 10;
            }
        }

        // Replace the default issues or findings
        report.issues = dynamicIssues;
        report.findings = dynamicIssues; 
        
        if (!report.summary) report.summary = {};
        report.summary.risk_score = Math.max(0, score);
        report.risk_score = report.summary.risk_score;
        */
        // ==========================================
        
        await job.updateProgress(95); // Phase 4: Finalizing report persistence
        
        // v2.4.120: Certification Suffix Promotion (Worker Logic)
        const fs = require('fs-extra');
        const certifiedPath = require('path').join(outputDir, 'certified.pdf');
        
        if (!(await fs.pathExists(certifiedPath))) {
            logger.info({ jobId, certifiedPath }, 'CERTIFY_PROMOTION_START');
            await fs.copy(filePath, certifiedPath);
            logger.info({ jobId }, 'CERTIFY_PROMOTION_END');
        }

        return {
            status: 'COMPLETED',
            report,
            artifacts: {
                certified_pdf: 'certified.pdf'
            },
            tenantId,
            jobId,
            processedAt: new Date().toISOString()
        };
    }
}

module.exports = AnalyzeProcessor;
