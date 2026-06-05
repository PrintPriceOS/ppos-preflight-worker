const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'processors/AutofixProcessor.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Replace repair extraction
const oldExtract = `        // Extract repairs to ensure complete preservation
        const allRepairs = Array.isArray(result?.repairs) ? result.repairs : (Array.isArray(result?.fixes) ? result.fixes : []);
        const appliedFixes = allRepairs.filter(r => r?.status === 'APPLIED');
        const skippedFixes = allRepairs.filter(r => r?.status === 'SKIPPED');
        const failedFixes = allRepairs.filter(r => r?.status === 'FAILED' || r?.status === 'UNSUPPORTED');`;

const newExtract = `        // Extract repairs to ensure complete preservation
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
            toolchain.qpdf.version = qpdfOut.stdout.split('\\n')[0].trim();
        } catch (e) {}
        
        try { 
            let gsOut;
            if (process.platform === 'win32') {
                gsOut = await execPromise('gswin64c --version');
            } else {
                gsOut = await execPromise('gs --version');
            }
            toolchain.ghostscript.available = true; 
            toolchain.ghostscript.version = gsOut.stdout.split('\\n')[0].trim();
        } catch (e) {}

        if (!toolchain.qpdf.available && requestedFixes.includes('REBUILD_XREF')) {
            skippedFixes.push({ fix_id: 'REBUILD_XREF', status: 'SKIPPED', reason: 'TOOL_NOT_AVAILABLE', message: 'qpdf not available' });
        }

        const hasCriticalFailed = failedFixes.some(f => f.risk_level === 'CRITICAL');
        const requiresReviewPolicy = reviewRequired || appliedFixes.some(f => f.risk_level === 'HIGH' || f.risk_level === 'CRITICAL' || f.requires_human_review);
        if (requiresReviewPolicy) {
            productionCertified = false;
        }`;

content = content.replace(oldExtract, newExtract);

// 2. Replace requiresReview / artifactClient
const oldRequiresReview = `        const requiresReview = failedFixes.length > 0 || result?.status === 'REVIEW_REQUIRED';`;
const newRequiresReview = `        const requiresReview = requiresReviewPolicy;
        const createCertifiedPdf = productionCertified && !hasCriticalFailed && !requiresReview;
        
        if (requiresReview) {
            logger.info({ jobId }, '[PREFLIGHT-WORKER][REVIEW_REQUIRED_ARTIFACT_POLICY]');
            logger.info({ jobId }, '[PREFLIGHT-WORKER][CERTIFIED_ARTIFACT_SUPPRESSED_REVIEW_REQUIRED]');
        }
        if (createCertifiedPdf) {
            logger.info({ jobId }, '[PREFLIGHT-WORKER][CERTIFIED_ARTIFACT_READY]');
        }`;
content = content.replace(oldRequiresReview, newRequiresReview);

// 3. Replace registerArtifact metadata
const oldMeta = `                    const meta = { processor: "AUTOFIX", ...extraMetadata };`;
const newMeta = `                    const meta = { 
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
                    };`;
content = content.replace(oldMeta, newMeta);

// 4. Update the logic for creating certified_pdf
const oldCertifiedPdfReg = `                await registerArtifact('certified_pdf', certifiedPath, 'certified.pdf');
                verifiedArtifacts.certified_pdf = 'certified.pdf';`;
const newCertifiedPdfReg = `                if (createCertifiedPdf) {
                    await registerArtifact('certified_pdf', certifiedPath, 'certified.pdf', { production_certified: true });
                    verifiedArtifacts.certified_pdf = 'certified.pdf';
                }`;
content = content.replace(oldCertifiedPdfReg, newCertifiedPdfReg);

// 5. Replace auditData definition and add delta_report
const oldAuditData = `        // Materialize fix_audit.json
        const auditReportPath = \`\${outputDir}/fix_audit.json\`;
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
        }`;

const newAuditData = `        // Materialize fix_audit.json
        logger.info({ jobId }, '[PREFLIGHT-WORKER][FIX_AUDIT_V2_WRITE_START]');
        const auditReportPath = \`\${outputDir}/fix_audit.json\`;
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
        const deltaReportPath = \`\${outputDir}/delta_report.json\`;
        const deltaData = {
            job_id: jobId,
            changes: appliedFixes.map(f => f.fix_id || f.code),
            boxes_changed: [],
            color_converted: appliedFixes.some(f => f.fix_id === 'CONVERT_CMYK' || f.code === 'CONVERT_CMYK'),
            interactive_removed: appliedFixes.some(f => f.fix_id === 'FLATTEN_INTERACTIVE' || f.code === 'FLATTEN_INTERACTIVE'),
            skipped_fixes: skippedFixes.map(f => ({ fix_id: f.fix_id || f.code, reason: f.reason })),
            visual_review_required: requiresReviewPolicy
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
        }`;

content = content.replace(oldAuditData, newAuditData);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Update complete');
