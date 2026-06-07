const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const os = require('os');

// Mock require dependencies
const originalRequire = require('module').prototype.require;
require('module').prototype.require = function(request) {
    if (request === 'uuid') {
        return { v4: () => 'mock-uuid' };
    }
    if (request === '../utils/ControlPlaneArtifacts') {
        return class {
            constructor() {}
            async register(opts) { return true; }
        };
    }
    if (request === '../utils/StorageManager') {
        return class {
            constructor() {}
            getJobSubfolder(tenantId, jobId, sub) {
                return path.join(os.tmpdir(), 'ppos-test', tenantId, jobId, sub);
            }
        };
    }
    if (request === '@ppos/preflight-engine') {
        return {
            createStandardEngine: () => global.engineMock
        };
    }
    if (request === '@ppos/shared-infra/packages/data/db') {
        return {
            execute: async () => []
        };
    }
    if (request === 'fs-extra') {
        return {
            ...fsPromises,
            pathExists: async (p) => {
                try { await fsPromises.access(p); return true; } catch (e) { return false; }
            },
            ensureDir: async (d) => {
                await fsPromises.mkdir(d, { recursive: true });
            },
            writeJson: async (p, obj, opts) => {
                await fsPromises.writeFile(p, JSON.stringify(obj, null, opts.spaces || 2));
            },
            readJson: async (p) => {
                const data = await fsPromises.readFile(p, 'utf8');
                return JSON.parse(data);
            },
            copy: async (src, dest) => {
                await fsPromises.copyFile(src, dest);
            }
        };
    }
    return originalRequire.call(this, request);
};

const AutofixProcessor = require('../processors/AutofixProcessor');

const engineReportPath = process.env.PHASE61E_ENGINE_REPORT || path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase61e_engine_structural_metadata_regression.json');

async function runTest(scenarioDef, index) {
    console.log(`\n--- Running Scenario: ${scenarioDef.scenario || 'Fallback'} ---`);
    
    // Map scenario to mock engine result
    const mockResult = {
        ok: true,
        fixedPath: path.join(os.tmpdir(), `engine_fixed_${index}.pdf`),
        applied_fixes: scenarioDef.applied_fixes || [],
        skipped_fixes: scenarioDef.skipped_fixes || [],
        failed_fixes: scenarioDef.failed_fixes || [],
        fix_results: [],
        structural_metadata_governance: scenarioDef.structural_metadata_governance || {
            structural_fix_applied: true,
            metadata_cleanup_applied: true,
            object_streams_normalized: false,
            false_certification_revoked: false,
            invalid_pdfx_metadata_stripped: false,
            invalid_pdfa_metadata_stripped: false,
            standard_metadata_normalized: false,
            internal_standard_report_generated: true,
            standard_certified: false,
            pdfx_compliance_claimed: false,
            pdfa_compliance_claimed: false,
            compliance_claim_allowed: false,
            validation_performed: false,
            validation_passed: false
        }
    };

    if (scenarioDef.input_artifact === 'certified.pdf' || (scenarioDef.scenario && scenarioDef.scenario.includes('certified.pdf'))) {
        mockResult.fixedPath = path.join(os.tmpdir(), `certified.pdf`);
    } else {
        mockResult.fixedPath = path.join(os.tmpdir(), `engine_fixed_${index}.pdf`);
    }

    global.engineMock = {
        autofixPdf: async () => mockResult
    };

    const jobId = `job-61e-${index}-${Date.now()}`;
    const tenantId = 'tenant-test';
    const tempDir = path.join(os.tmpdir(), 'ppos-test', tenantId, jobId, 'temp');
    const outputDir = path.join(os.tmpdir(), 'ppos-test', tenantId, jobId, 'output');
    
    await fsPromises.mkdir(tempDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    
    const inputPdf = path.join(tempDir, 'input.pdf');
    await fsPromises.writeFile(inputPdf, 'dummy pdf content');

    if (mockResult.fixedPath) {
        await fsPromises.writeFile(mockResult.fixedPath, 'dummy fixed pdf');
    }

    const job = {
        data: {
            jobId,
            tenantId,
            findings: [],
            input: {
                fileUrl: inputPdf,
                fixes: mockResult.applied_fixes.map(f => f.fix_id)
            }
        },
        updateProgress: async () => {}
    };

    const logger = {
        info: (...args) => {},
        warn: (...args) => {},
        error: (...args) => console.error(...args)
    };

    const result = await AutofixProcessor.process(job, logger);
    
    const fixAuditPath = path.join(outputDir, 'fix_audit.json');
    const deltaReportPath = path.join(outputDir, 'delta_report.json');
    
    const fixAuditStr = await fsPromises.readFile(fixAuditPath, 'utf8');
    const fixAudit = JSON.parse(fixAuditStr);
    
    const deltaReportStr = await fsPromises.readFile(deltaReportPath, 'utf8');
    const deltaReport = JSON.parse(deltaReportStr);
    
    let pass = true;
    let notes = [];

    // evidence validation
    if (fixAudit.applied_fixes.length !== mockResult.applied_fixes.length) {
        pass = false; notes.push('applied_fixes evidence dropped in fix_audit');
    }
    if (deltaReport.changes.length !== mockResult.applied_fixes.length) {
        pass = false; notes.push('applied_fixes evidence dropped in delta_report');
    }

    if (!fixAudit.structural_metadata_governance) {
        pass = false; notes.push('structural_metadata_governance missing in fix_audit');
    }
    if (!deltaReport.structural_metadata_governance) {
        pass = false; notes.push('structural_metadata_governance missing in delta_report');
    }

    const smg = fixAudit.structural_metadata_governance || {};
    if (smg.standard_certified === true) {
        pass = false; notes.push('metadata cleanup created standard_certified=true');
    }
    if (smg.pdfx_compliance_claimed === true) {
        pass = false; notes.push('metadata cleanup created pdfx_compliance_claimed=true');
    }
    if (smg.pdfa_compliance_claimed === true) {
        pass = false; notes.push('metadata cleanup created pdfa_compliance_claimed=true');
    }
    if (smg.validation_performed === true) {
        pass = false; notes.push('internal report sets validation_performed=true');
    }

    // Check artifact trust conservatism
    const at = fixAudit.artifact_trust;
    if (at && at.primary_artifact_type === 'certified_pdf' && !at.certified_pdf_allowed) {
        // Just checking if certified.pdf became trusted by filename
        if (!scenarioDef.scenario || !scenarioDef.scenario.includes('legitimately certified')) {
            pass = false; notes.push('certified.pdf became trusted by filename');
        }
    }

    if (pass) {
        console.log(`  => PASS`);
    } else {
        console.log(`  => FAIL: ${notes.join('; ')}`);
        throw new Error(`Smoke Test Failed: ${notes.join('; ')}`);
    }

    return {
        scenario: scenarioDef.scenario || 'Synthetic Fallback',
        structural_metadata_governance: smg,
        pass: pass,
        notes: notes.join('; ') || 'As expected'
    };
}

async function main() {
    console.log("Loading Engine Report from:", engineReportPath);
    let engineData = [];
    let inputMode = "ENGINE_REPORT";
    try {
        const raw = await fsPromises.readFile(engineReportPath, 'utf8');
        engineData = JSON.parse(raw);
    } catch(e) {
        console.warn("Could not load engine report, using synthetic fallback:", e.message);
        inputMode = "SYNTHETIC_POLICY_FALLBACK";
        engineData = [
            {
                scenario: "Synthetic: Structural fix with cleanup",
                structural_metadata_governance: {
                    structural_fix_applied: true,
                    metadata_cleanup_applied: true,
                    object_streams_normalized: true,
                    false_certification_revoked: true,
                    invalid_pdfx_metadata_stripped: true,
                    invalid_pdfa_metadata_stripped: false,
                    standard_metadata_normalized: true,
                    internal_standard_report_generated: true,
                    standard_certified: false,
                    pdfx_compliance_claimed: false,
                    pdfa_compliance_claimed: false,
                    compliance_claim_allowed: false,
                    validation_performed: false,
                    validation_passed: false
                },
                applied_fixes: [{fix_id: 'NORMALIZE_OBJECT_STREAMS'}],
                skipped_fixes: [],
                failed_fixes: []
            },
            {
                scenario: "Synthetic: certified.pdf with internal standard report only",
                input_artifact: "certified.pdf",
                structural_metadata_governance: {
                    structural_fix_applied: false,
                    metadata_cleanup_applied: true,
                    object_streams_normalized: false,
                    false_certification_revoked: false,
                    invalid_pdfx_metadata_stripped: false,
                    invalid_pdfa_metadata_stripped: false,
                    standard_metadata_normalized: false,
                    internal_standard_report_generated: true,
                    standard_certified: false,
                    pdfx_compliance_claimed: false,
                    pdfa_compliance_claimed: false,
                    compliance_claim_allowed: false,
                    validation_performed: false,
                    validation_passed: false
                },
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: []
            }
        ];
    }

    const reportResults = [];

    let hasFailure = false;
    for (let i = 0; i < engineData.length; i++) {
        try {
            const res = await runTest(engineData[i], i);
            reportResults.push(res);
        } catch(e) {
            hasFailure = true;
            console.error(e.message);
            reportResults.push({
                scenario: engineData[i].scenario || 'Unknown',
                pass: false,
                notes: e.message
            });
        }
    }

    const reportDir = path.resolve(__dirname, '../reports');
    await fsPromises.mkdir(reportDir, { recursive: true });

    const jsonReportPath = path.join(reportDir, 'phase61e_worker_structural_metadata_regression.json');
    await fsPromises.writeFile(jsonReportPath, JSON.stringify({ input_mode: inputMode, results: reportResults }, null, 2));

    const mdReportPath = path.join(reportDir, 'phase61e_worker_structural_metadata_regression.md');
    let mdContent = `# Phase 61E.2 Worker Structural Metadata Regression\n\n`;
    mdContent += `Input Mode: \`${inputMode}\`\n\n`;
    reportResults.forEach(r => {
        mdContent += `## ${r.scenario}\n`;
        mdContent += `- Pass: ${r.pass ? '✅' : '❌'}\n`;
        if (r.structural_metadata_governance) {
            mdContent += `- Structural Fix Applied: ${r.structural_metadata_governance.structural_fix_applied}\n`;
            mdContent += `- Metadata Cleanup Applied: ${r.structural_metadata_governance.metadata_cleanup_applied}\n`;
        }
        mdContent += `- Notes: ${r.notes}\n\n`;
    });
    await fsPromises.writeFile(mdReportPath, mdContent);

    console.log(`\nReports generated at:\n- ${jsonReportPath}\n- ${mdReportPath}`);
    if (hasFailure) {
        console.error("Smoke tests failed.");
        process.exit(1);
    } else {
        console.log("All smoke tests passed.");
    }
}

main();
