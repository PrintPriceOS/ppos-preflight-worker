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
                return path.join(os.tmpdir(), 'ppos-test-55b', tenantId, jobId, sub);
            }
        };
    }
    if (request === '@ppos/preflight-engine') {
        return {
            createStandardEngine: () => global.engineMock
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

const allReports = [];

async function runTest(name, scenarioOpts) {
    console.log(`\n--- Running Test: ${name} ---`);
    
    global.engineMock = {
        autofixPdf: async () => scenarioOpts.engineMockResult
    };

    const jobId = `test-job-55b-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const tenantId = 'test-tenant';
    const tempDir = path.join(os.tmpdir(), 'ppos-test-55b', tenantId, jobId, 'temp');
    const outputDir = path.join(os.tmpdir(), 'ppos-test-55b', tenantId, jobId, 'output');
    
    await fsPromises.mkdir(tempDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    
    const inputPdf = path.join(tempDir, 'input.pdf');
    await fsPromises.writeFile(inputPdf, 'dummy pdf content');

    if (scenarioOpts.engineMockResult && scenarioOpts.engineMockResult.fixedPath) {
        await fsPromises.writeFile(scenarioOpts.engineMockResult.fixedPath, 'dummy fixed pdf');
    }

    const job = {
        data: {
            jobId,
            tenantId,
            input: {
                fileUrl: inputPdf,
                fixes: scenarioOpts.requestedFixes || [],
                findings: scenarioOpts.findings || []
            },
            pdfx_compliance_claimed: scenarioOpts.pdfx_compliance_claimed || false,
            validation_performed: scenarioOpts.validation_performed || false,
            validation_passed: scenarioOpts.validation_passed || false
        },
        updateProgress: async () => {}
    };

    const logger = {
        info: () => {},
        warn: () => {},
        error: () => {}
    };

    const result = await AutofixProcessor.process(job, logger);
    
    const fixAuditPath = path.join(outputDir, 'fix_audit.json');
    const fixAudit = JSON.parse(await fsPromises.readFile(fixAuditPath, 'utf8'));
    
    const deltaReportPath = path.join(outputDir, 'delta_report.json');
    const deltaReport = JSON.parse(await fsPromises.readFile(deltaReportPath, 'utf8'));

    // Verify expectations
    const gov = deltaReport.standards_certification_governance;
    if (!gov) throw new Error("standards_certification_governance missing in delta_report");

    if (scenarioOpts.expect) {
        for (const [k, v] of Object.entries(scenarioOpts.expect)) {
            if (k === 'review_required_reasons_includes') {
                if (!gov.review_required_reasons.includes(v)) {
                    throw new Error(`Expected review_required_reasons to include ${v}`);
                }
            } else if (k === 'skipped_fixes_contains') {
                if (!fixAudit.skipped_fixes.some(f => (f.fix_id || f.code) === v)) {
                    throw new Error(`Expected skipped_fixes to contain ${v}`);
                }
            } else if (k === 'applied_fixes_not_contains') {
                if (fixAudit.applied_fixes.some(f => (f.fix_id || f.code) === v)) {
                    throw new Error(`Expected applied_fixes to NOT contain ${v}`);
                }
            } else {
                let actual = gov[k];
                if (actual === undefined && fixAudit[k] !== undefined) actual = fixAudit[k];
                if (actual !== v) {
                    throw new Error(`Expected ${k}=${v}, got ${actual}`);
                }
            }
        }
    }

    if (scenarioOpts.assertNeverApplied) {
        for (const code of scenarioOpts.assertNeverApplied) {
            if (fixAudit.applied_fixes.some(f => (f.fix_id || f.code) === code)) {
                throw new Error(`Finding ${code} was incorrectly left in applied_fixes`);
            }
        }
    }

    console.log(`Test ${name} PASS`);

    allReports.push({
        scenario: name,
        requested_fixes: scenarioOpts.requestedFixes || [],
        findings: scenarioOpts.findings || [],
        applied_fixes: fixAudit.applied_fixes,
        skipped_fixes: fixAudit.skipped_fixes,
        failed_fixes: fixAudit.failed_fixes,
        standards_certification_governance: gov,
        review_required: fixAudit.review_required,
        production_certified: fixAudit.production_certified,
        certified_pdf_allowed: fixAudit.artifact_policy.certified_pdf,
        standard_certified: gov.standard_certified,
        pdfx_compliance_claimed: gov.pdfx_compliance_claimed,
        pdfa_compliance_claimed: gov.pdfa_compliance_claimed,
        compliance_claim_allowed: gov.compliance_claim_allowed,
        validator_required: gov.validator_required,
        validator_available: gov.validator_available,
        validation_passed: gov.validation_passed,
        pass: true
    });
}

async function main() {
    await fsPromises.mkdir(path.join(__dirname, '../reports'), { recursive: true });

    // 1. PDFX_CLAIMED_BUT_NOT_VALIDATED finding
    await runTest('1. PDFX_CLAIMED_BUT_NOT_VALIDATED finding', {
        findings: [{ id: 'PDFX_CLAIMED_BUT_NOT_VALIDATED' }],
        engineMockResult: { fixedPath: path.join(os.tmpdir(), 'f1.pdf'), applied_fixes: [], skipped_fixes: [], failed_fixes: [], production_certified: true },
        expect: {
            review_required: true,
            production_certified: false,
            standard_certified: false,
            certified_pdf_allowed: false,
            review_required_reasons_includes: 'PDFX_CLAIMED_BUT_NOT_VALIDATED'
        }
    });

    // 2. PDFX_MISSING finding
    await runTest('2. PDFX_MISSING finding', {
        findings: [{ id: 'PDFX_MISSING' }],
        engineMockResult: { fixedPath: path.join(os.tmpdir(), 'f2.pdf'), applied_fixes: [], skipped_fixes: [], failed_fixes: [], production_certified: true },
        expect: {
            standard_certified: false,
            pdfx_compliance_claimed: false,
            applied_fixes_not_contains: 'CONVERT_TO_PDFX'
        }
    });

    // 3. VALIDATE_PDFX skipped / validator unavailable
    await runTest('3. VALIDATE_PDFX skipped / validator unavailable', {
        requestedFixes: ['VALIDATE_PDFX'],
        engineMockResult: { fixedPath: path.join(os.tmpdir(), 'f3.pdf'), applied_fixes: [], skipped_fixes: [{ fix_id: 'VALIDATE_PDFX', status: 'SKIPPED' }], failed_fixes: [], production_certified: true },
        expect: {
            skipped_fixes_contains: 'VALIDATE_PDFX',
            validator_required: true,
            validator_available: false,
            compliance_claim_allowed: false,
            pdfx_compliance_claimed: false
        }
    });

    // 4. GENERATE_PDFX / CONVERT_TO_PDFX unsupported
    await runTest('4. GENERATE_PDFX / CONVERT_TO_PDFX unsupported', {
        requestedFixes: ['CONVERT_TO_PDFX'],
        engineMockResult: { fixedPath: path.join(os.tmpdir(), 'f4.pdf'), applied_fixes: [], skipped_fixes: [{ fix_id: 'CONVERT_TO_PDFX', status: 'SKIPPED', requires_human_review: true, production_safe: false }], failed_fixes: [], production_certified: true },
        expect: {
            skipped_fixes_contains: 'CONVERT_TO_PDFX',
            pdfx_compliance_claimed: false,
            applied_fixes_not_contains: 'CONVERT_TO_PDFX'
        }
    });

    // 5. INJECT_OUTPUT_INTENT applied
    await runTest('5. INJECT_OUTPUT_INTENT applied', {
        engineMockResult: { fixedPath: path.join(os.tmpdir(), 'f5.pdf'), applied_fixes: [{ fix_id: 'INJECT_OUTPUT_INTENT', status: 'APPLIED' }], skipped_fixes: [], failed_fixes: [], production_certified: true },
        expect: {
            pdfx_compliance_claimed: false,
            standard_certified: false,
            compliance_claim_allowed: false,
            outputintent_does_not_prove_pdfx: true
        }
    });

    // 6. Engine incorrectly reports unsupported standards fix as APPLIED
    await runTest('6. Engine incorrectly reports unsupported standards fix as APPLIED', {
        engineMockResult: { fixedPath: path.join(os.tmpdir(), 'f6.pdf'), applied_fixes: [{ fix_id: 'CONVERT_TO_PDFX', status: 'APPLIED', validator_available: false }], skipped_fixes: [], failed_fixes: [], production_certified: true },
        expect: {
            skipped_fixes_contains: 'CONVERT_TO_PDFX',
            pdfx_compliance_claimed: false
        }
    });

    // 7. Payload falsely claims PDF/X compliance without validator evidence
    await runTest('7. Payload falsely claims PDF/X compliance without validator evidence', {
        pdfx_compliance_claimed: true,
        validation_performed: false,
        validation_passed: false,
        engineMockResult: { fixedPath: path.join(os.tmpdir(), 'f7.pdf'), applied_fixes: [], skipped_fixes: [], failed_fixes: [], production_certified: true },
        expect: {
            pdfx_compliance_claimed: false,
            standard_certified: false,
            compliance_claim_allowed: false,
            review_required_reasons_includes: 'STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE'
        }
    });

    // 8. Future valid validator evidence
    await runTest('8. Future valid validator evidence', {
        engineMockResult: { 
            fixedPath: path.join(os.tmpdir(), 'f8.pdf'), 
            applied_fixes: [{ fix_id: 'VALIDATE_PDFX', status: 'APPLIED', validation_passed: true, validation_performed: true, validator_name: 'veraPDF', validator_version: '1.24', standard_detected: 'PDF/X-4', validation_report_available: true }], 
            skipped_fixes: [], 
            failed_fixes: [], 
            production_certified: true 
        },
        expect: {
            standard_certified: true,
            pdfx_compliance_claimed: true,
            compliance_claim_allowed: true
        }
    });

    // 9. Findings never applied
    await runTest('9. Findings never applied', {
        engineMockResult: { 
            fixedPath: path.join(os.tmpdir(), 'f9.pdf'), 
            applied_fixes: [
                { fix_id: 'PDFX_MISSING', status: 'APPLIED' },
                { fix_id: 'PDFX_INVALID', status: 'APPLIED' },
                { fix_id: 'PDFX_CLAIMED_BUT_NOT_VALIDATED', status: 'APPLIED' },
                { fix_id: 'STANDARD_VALIDATOR_UNAVAILABLE', status: 'APPLIED' },
                { fix_id: 'CERTIFIED_PDF_NOT_STANDARD_CERTIFIED', status: 'APPLIED' },
                { fix_id: 'PRODUCTION_CERTIFIED_WITHOUT_STANDARD_VALIDATION', status: 'APPLIED' }
            ], 
            skipped_fixes: [], 
            failed_fixes: [], 
            production_certified: true 
        },
        assertNeverApplied: [
            'PDFX_MISSING', 'PDFX_INVALID', 'PDFX_CLAIMED_BUT_NOT_VALIDATED', 
            'STANDARD_VALIDATOR_UNAVAILABLE', 'CERTIFIED_PDF_NOT_STANDARD_CERTIFIED', 
            'PRODUCTION_CERTIFIED_WITHOUT_STANDARD_VALIDATION'
        ]
    });

    console.log('\nGenerating reports...');
    await fsPromises.writeFile(
        path.join(__dirname, '../reports/phase55b_worker_standards_certification_policy.json'),
        JSON.stringify(allReports, null, 2)
    );

    let md = '# Phase 55B Worker Standards Certification Policy Report\n\n';
    md += '| Scenario | review_required | standard_certified | pdfx_compliance_claimed | compliance_claim_allowed | validator_available | Pass/Fail |\n';
    md += '|---|---|---|---|---|---|---|\n';
    for (const r of allReports) {
        md += `| ${r.scenario} | ${r.review_required} | ${r.standard_certified} | ${r.pdfx_compliance_claimed} | ${r.compliance_claim_allowed} | ${r.validator_available} | ${r.pass ? 'PASS' : 'FAIL'} |\n`;
    }
    
    await fsPromises.writeFile(
        path.join(__dirname, '../reports/phase55b_worker_standards_certification_policy.md'),
        md
    );

    console.log('Done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
