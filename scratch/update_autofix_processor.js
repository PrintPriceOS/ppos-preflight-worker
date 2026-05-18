const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../processors/AutofixProcessor.js');
let content = fs.readFileSync(targetFile, 'utf8');

// Replacement 1
const t1 = `            verifiedArtifacts.certified_pdf = 'certified.pdf';
            verifiedArtifacts.fixed_pdf = 'fixed.pdf';

            logger.info({ jobId, artifact: 'certified_pdf' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
            logger.info({ jobId, artifact: 'fixed_pdf' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');`;

const r1 = `            verifiedArtifacts.certified_pdf = 'certified.pdf';
            verifiedArtifacts.fixed_pdf = 'fixed.pdf';
            verifiedArtifacts.final_fixed_pdf = 'fixed.pdf';

            logger.info({ jobId, artifact: 'certified_pdf' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
            logger.info({ jobId, artifact: 'fixed_pdf' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
            logger.info({ jobId, artifact: 'final_fixed_pdf' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');`;

// Replacement 2
const t2 = `            await registerArtifact('certified_pdf', certifiedPath, 'certified.pdf');
            await registerArtifact('fixed_pdf', fixedPdfPath, 'fixed.pdf');`;

const r2 = `            await registerArtifact('certified_pdf', certifiedPath, 'certified.pdf');
            await registerArtifact('fixed_pdf', fixedPdfPath, 'fixed.pdf');
            await registerArtifact('final_fixed_pdf', fixedPdfPath, 'fixed.pdf');`;

// Replacement 3
const t3 = `        // Optional: register audit report if it exists
        const auditReportPath = \`\${outputDir}/fix_audit.json\`;
        if (await fs.pathExists(auditReportPath)) {
            verifiedArtifacts.audit_report = 'fix_audit.json';
            logger.info({ jobId, artifact: 'audit_report' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
            
            // Register audit report with Control Plane
            const stats = await fs.stat(auditReportPath);
            
            let auditChecksum = null;
            try {
                auditChecksum = await sha256File(auditReportPath);
                logger.info({ jobId, type: 'audit_report', checksumSha256: auditChecksum }, '[WORKER][ARTIFACT][SHA256][OK]');
            } catch (hashError) {
                logger.warn({ jobId, type: 'audit_report', error: hashError.message }, '[WORKER][ARTIFACT][SHA256][WARN]');
            }

            await artifactClient.register({
                jobId,
                tenantId,
                artifactType: 'audit_report',
                filename: 'fix_audit.json',
                storageKey: auditReportPath,
                sizeBytes: stats.size,
                checksumSha256: auditChecksum,
                mimeType: 'application/json',
                metadata: {
                    processor: "AUTOFIX"
                }
            });
        }`;

const r3 = `        // Optional: register audit report if it exists
        const auditReportPath = \`\${outputDir}/fix_audit.json\`;
        if (await fs.pathExists(auditReportPath)) {
            verifiedArtifacts.audit_report = 'fix_audit.json';
            verifiedArtifacts.fix_audit = 'fix_audit.json';
            logger.info({ jobId, artifact: 'audit_report' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
            logger.info({ jobId, artifact: 'fix_audit' }, '[WORKER][AUTOFIX][ARTIFACT-REGISTERED]');
            
            // Register audit report with Control Plane
            const stats = await fs.stat(auditReportPath);
            
            let auditChecksum = null;
            try {
                auditChecksum = await sha256File(auditReportPath);
                logger.info({ jobId, type: 'fix_audit', checksumSha256: auditChecksum }, '[WORKER][ARTIFACT][SHA256][OK]');
            } catch (hashError) {
                logger.warn({ jobId, type: 'fix_audit', error: hashError.message }, '[WORKER][ARTIFACT][SHA256][WARN]');
            }

            await artifactClient.register({
                jobId,
                tenantId,
                artifactType: 'audit_report',
                filename: 'fix_audit.json',
                storageKey: auditReportPath,
                sizeBytes: stats.size,
                checksumSha256: auditChecksum,
                mimeType: 'application/json',
                metadata: {
                    processor: "AUTOFIX"
                }
            });

            await artifactClient.register({
                jobId,
                tenantId,
                artifactType: 'fix_audit',
                filename: 'fix_audit.json',
                storageKey: auditReportPath,
                sizeBytes: stats.size,
                checksumSha256: auditChecksum,
                mimeType: 'application/json',
                metadata: {
                    processor: "AUTOFIX"
                }
            });
        }`;

// Replacement 4
const t4 = `        const finalArtifacts = {
            ...verifiedArtifacts,
            final_fixed_pdf: verifiedArtifacts.fixed_pdf || 'fixed.pdf'
        };`;

const r4 = `        const finalArtifacts = {
            ...verifiedArtifacts,
            final_fixed_pdf: verifiedArtifacts.final_fixed_pdf || verifiedArtifacts.fixed_pdf || 'fixed.pdf',
            fix_audit: verifiedArtifacts.fix_audit || verifiedArtifacts.audit_report || 'fix_audit.json'
        };`;

// Check and replace
const checkAndReplace = (target, replacement, label) => {
    if (content.includes(target)) {
        content = content.replace(target, replacement);
        console.log(`[REPLACE] ${label} - Success`);
    } else {
        // Normalise line endings and check
        const normTarget = target.replace(/\r\n/g, '\n');
        const normContent = content.replace(/\r\n/g, '\n');
        if (normContent.includes(normTarget)) {
            content = normContent.replace(normTarget, replacement.replace(/\r\n/g, '\n'));
            console.log(`[REPLACE] ${label} (normalized endings) - Success`);
        } else {
            console.error(`[REPLACE] ${label} - Target not found!`);
        }
    }
};

checkAndReplace(t1, r1, "Block 1: verifiedArtifacts keys");
checkAndReplace(t2, r2, "Block 2: registerArtifact calls");
checkAndReplace(t3, r3, "Block 3: audit report double registration");
checkAndReplace(t4, r4, "Block 4: finalArtifacts keys");

fs.writeFileSync(targetFile, content, 'utf8');
console.log('Update complete.');
