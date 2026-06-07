const fs = require('fs');
const path = require('path');
const Module = require('module');
const originalRequire = Module.prototype.require;

let currentEngineResult = null;

Module.prototype.require = function() {
    if (arguments[0] === '@ppos/preflight-engine') {
        return {
            createStandardEngine: () => ({
                autofixPdf: async (input, payload) => {
                    return currentEngineResult;
                }
            })
        };
    }
    if (arguments[0] === '@ppos/shared-infra/packages/data/db') {
        return { execute: async () => [] };
    }
    return originalRequire.apply(this, arguments);
};

const AutofixProcessor = require('../processors/AutofixProcessor');
const engineReportPath = path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase61a_engine_structural_metadata_fixes.json');
const outputPathJson = path.join(__dirname, '../reports/phase61b_worker_structural_metadata_policy.json');
const outputPathMd = path.join(__dirname, '../reports/phase61b_worker_structural_metadata_policy.md');

let inputMode = "ENGINE_REPORT";
let engineReport = null;

if (fs.existsSync(engineReportPath)) {
    try {
        engineReport = JSON.parse(fs.readFileSync(engineReportPath, 'utf8'));
    } catch (e) {
        console.warn('Failed to parse engine report, using synthetic fallback.');
    }
}

if (!engineReport) {
    inputMode = "SYNTHETIC_POLICY_FALLBACK";
    engineReport = { scenarios: [] }; // We will construct the scenarios directly below
}

// Ensure reports directory exists
const reportsDir = path.dirname(outputPathJson);
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
}

// We will mock the engine and storage
const mockStorage = {
    getJobSubfolder: (tenantId, jobId, folder) => {
        const dir = path.join(__dirname, `../temp_smoke_${jobId}`, folder);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }
};

const scenarios = [
    {
        name: "1. NORMALIZE_OBJECT_STREAMS applied cleanly",
        fixes: [{ code: 'NORMALIZE_OBJECT_STREAMS', status: 'APPLIED' }],
        production_safe: true,
        production_certified: true,
        expect_production_certified: true,
        expect_structural_fix: true
    },
    {
        name: "2. NORMALIZE_OBJECT_STREAMS skipped because qpdf missing",
        fixes: [{ code: 'NORMALIZE_OBJECT_STREAMS', status: 'SKIPPED', reason: 'TOOL_NOT_AVAILABLE' }],
        production_safe: false,
        expect_structural_fix: false
    },
    {
        name: "3. REVOKE_FALSE_CERTIFICATION applied",
        fixes: [{ code: 'REVOKE_FALSE_CERTIFICATION', status: 'APPLIED' }],
        production_safe: false,
        standard_claimed: 'PDF/X-4',
        expect_standard_certified: false,
        expect_production_certified: false,
        expect_metadata_cleanup: true
    },
    {
        name: "4. STRIP_INVALID_PDFX_METADATA applied",
        fixes: [{ code: 'STRIP_INVALID_PDFX_METADATA', status: 'APPLIED' }],
        production_safe: false,
        pdfx_compliance_claimed: true,
        expect_standard_certified: false,
        expect_metadata_cleanup: true
    },
    {
        name: "5. STRIP_INVALID_PDFA_METADATA applied",
        fixes: [{ code: 'STRIP_INVALID_PDFA_METADATA', status: 'APPLIED' }],
        production_safe: false,
        pdfa_compliance_claimed: true,
        expect_standard_certified: false,
        expect_metadata_cleanup: true
    },
    {
        name: "6. NORMALIZE_STANDARD_METADATA applied",
        fixes: [{ code: 'NORMALIZE_STANDARD_METADATA', status: 'APPLIED' }],
        production_safe: false,
        expect_standard_certified: false,
        expect_metadata_cleanup: true
    },
    {
        name: "7. GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL generated",
        fixes: [{ code: 'GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL', status: 'APPLIED' }],
        production_safe: false,
        expect_validation_performed: false,
        expect_internal_report: true
    },
    {
        name: "8. Metadata cleanup with certified.pdf artifact present",
        fixes: [{ code: 'REVOKE_FALSE_CERTIFICATION', status: 'APPLIED' }],
        production_safe: true, // to try to force it
        production_certified: true,
        standard_certified: true, // to try to force it
        expect_standard_certified: false,
        expect_production_certified: false,
        expect_metadata_cleanup: true
    },
    {
        name: "9. Internal report must not become external validation evidence",
        fixes: [
            { code: 'GENERATE_STANDARD_VALIDATION_REPORT_INTERNAL', status: 'APPLIED' }
        ],
        validation_performed: true, // attempting to trick it
        validator_name: 'veraPDF',
        expect_validation_performed: false,
        expect_validator_evidence: false
    },
    {
        name: "10. Evidence preservation for skipped/failed states",
        fixes: [
            { code: 'NORMALIZE_OBJECT_STREAMS', status: 'FAILED', risk_level: 'HIGH' },
            { code: 'REVOKE_FALSE_CERTIFICATION', status: 'SKIPPED', reason: 'NOT_NEEDED' }
        ],
        production_safe: false,
        expect_preserved_evidence: true
    }
];

// Mocking child_process and standard engine for the test
const cp = require('child_process');
cp.exec = (cmd, cb) => {
    if (cmd.includes('qpdf --version')) return cb(null, { stdout: 'qpdf version 11.0.0\n' });
    if (cmd.includes('gswin64c') || cmd.includes('gs --version')) return cb(null, { stdout: 'GPL Ghostscript 10.0\n' });
    cb(null, { stdout: '' });
};

const preflightEngine = require('@ppos/preflight-engine');
preflightEngine.createStandardEngine = () => ({
    autofixPdf: async (input, payload) => {
        return currentEngineResult;
    }
});

const StorageManager = require('../utils/StorageManager');
StorageManager.prototype.getJobSubfolder = mockStorage.getJobSubfolder;

async function run() {
    console.log("Starting Phase 61B Smoke Test...");
    
    const results = {
        meta: {
            timestamp: new Date().toISOString(),
            input_mode: inputMode,
            scenarios_tested: scenarios.length
        },
        scenarios: []
    };

    let allPassed = true;

    for (let i = 0; i < scenarios.length; i++) {
        const s = scenarios[i];
        console.log(`Running Scenario ${i+1}: ${s.name}`);
        
        const jobId = `job_smoke_61b_${i}`;
        const tenantId = `tenant_smoke_61b`;
        
        const tempDir = mockStorage.getJobSubfolder(tenantId, jobId, 'temp');
        const outputDir = mockStorage.getJobSubfolder(tenantId, jobId, 'output');
        
        // Mock input pdf
        const dummyPdf = path.join(tempDir, 'input.pdf');
        fs.writeFileSync(dummyPdf, '%PDF-1.4\n%EOF');
        
        // Mock engine result
        const tempFixedPdf = path.join(tempDir, 'fixed_temp.pdf');
        fs.writeFileSync(tempFixedPdf, '%PDF-1.4\n%Fixed\n%EOF');
        
        currentEngineResult = {
            ok: true,
            status: 'COMPLETED',
            fixes: s.fixes,
            applied_fixes: s.fixes.filter(f => f.status === 'APPLIED'),
            skipped_fixes: s.fixes.filter(f => f.status === 'SKIPPED'),
            failed_fixes: s.fixes.filter(f => f.status === 'FAILED'),
            production_safe: s.production_safe,
            production_certified: s.production_certified || false,
            pdfx_compliance_claimed: s.pdfx_compliance_claimed || false,
            pdfa_compliance_claimed: s.pdfa_compliance_claimed || false,
            standard_certified: s.standard_certified || false,
            validation_performed: s.validation_performed || false,
            validator_name: s.validator_name || null,
            fixedPath: tempFixedPdf
        };
        
        const job = {
            data: {
                jobId,
                tenantId,
                input: { fileUrl: dummyPdf }
            }
        };

        let result;
        let auditData = null;
        let deltaData = null;
        
        try {
            result = await AutofixProcessor.process(job, {
                info: () => {}, warn: () => {}, error: () => {}
            });
            
            const auditPath = path.join(outputDir, 'fix_audit.json');
            if (fs.existsSync(auditPath)) {
                auditData = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
            }
            
            const deltaPath = path.join(outputDir, 'delta_report.json');
            if (fs.existsSync(deltaPath)) {
                deltaData = JSON.parse(fs.readFileSync(deltaPath, 'utf8'));
            }
            
        } catch (e) {
            console.error(e);
        }

        let passed = true;
        const checks = [];

        if (!auditData || !deltaData) {
            passed = false;
            checks.push("Reports missing");
        } else {
            const gov = auditData.structural_metadata_governance;
            
            if (s.expect_production_certified !== undefined) {
                const isProdCert = auditData.artifact_trust.production_certified;
                if (isProdCert !== s.expect_production_certified) {
                    passed = false;
                    checks.push(`Expected production_certified=${s.expect_production_certified}, got ${isProdCert}`);
                }
            }
            
            if (s.expect_structural_fix !== undefined) {
                if (gov.structural_fix_applied !== s.expect_structural_fix) {
                    passed = false;
                    checks.push(`Expected structural_fix_applied=${s.expect_structural_fix}, got ${gov.structural_fix_applied}`);
                }
            }
            
            if (s.expect_metadata_cleanup !== undefined) {
                if (gov.metadata_cleanup_applied !== s.expect_metadata_cleanup) {
                    passed = false;
                    checks.push(`Expected metadata_cleanup_applied=${s.expect_metadata_cleanup}, got ${gov.metadata_cleanup_applied}`);
                }
            }
            
            if (s.expect_standard_certified !== undefined) {
                const isStdCert = auditData.artifact_trust.standard_certified;
                if (isStdCert !== s.expect_standard_certified) {
                    passed = false;
                    checks.push(`Expected standard_certified=${s.expect_standard_certified}, got ${isStdCert}`);
                }
            }
            
            if (s.expect_validation_performed !== undefined) {
                if (gov.validation_performed !== s.expect_validation_performed) {
                    passed = false;
                    checks.push(`Expected validation_performed=${s.expect_validation_performed}, got ${gov.validation_performed}`);
                }
            }
            
            if (s.expect_validator_evidence !== undefined && !s.expect_validator_evidence) {
                if (auditData.standards_certification_governance.validation_performed) {
                    passed = false;
                    checks.push(`Expected validation_performed to be stripped from standards gov.`);
                }
            }
            
            if (s.expect_preserved_evidence) {
                const foundFail = auditData.failed_fixes.some(f => f.code === 'NORMALIZE_OBJECT_STREAMS');
                const foundSkip = auditData.skipped_fixes.some(f => f.code === 'REVOKE_FALSE_CERTIFICATION');
                if (!foundFail || !foundSkip) {
                    passed = false;
                    checks.push("Failed or Skipped fixes not preserved.");
                }
            }
            
            if (s.expect_internal_report) {
                if (!gov.internal_standard_report_generated) {
                    passed = false;
                    checks.push(`Expected internal_standard_report_generated=true`);
                }
            }
        }

        results.scenarios.push({
            name: s.name,
            passed,
            checks_failed: checks
        });
        
        if (!passed) allPassed = false;
    }

    fs.writeFileSync(outputPathJson, JSON.stringify(results, null, 2));

    let md = `# Phase 61B Worker Structural / Metadata Policy Smoke Test\n\n`;
    md += `**Timestamp**: ${results.meta.timestamp}\n`;
    md += `**Input Mode**: ${results.meta.input_mode}\n`;
    md += `**Status**: ${allPassed ? '✅ PASSED' : '❌ FAILED'}\n\n`;
    
    md += `## Scenarios\n\n`;
    results.scenarios.forEach(r => {
        md += `### ${r.name}\n`;
        md += `Status: ${r.passed ? '✅ Pass' : '❌ Fail'}\n`;
        if (r.checks_failed.length > 0) {
            md += `Errors:\n`;
            r.checks_failed.forEach(e => md += `- ${e}\n`);
        }
        md += `\n`;
    });

    fs.writeFileSync(outputPathMd, md);
    
    console.log(`\nSmoke test complete. Passed: ${allPassed}`);
    if (!allPassed) process.exit(1);
}

run();
