const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const Module = require('module');
let currentEngineMockResult = {};
const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
    if (request === '@ppos/preflight-engine') {
        return {
            createStandardEngine: () => ({ 
                autofixPdf: async () => {
                    return {
                        ok: true,
                        ...currentEngineMockResult
                    };
                }
            })
        };
    }
    if (request === '@ppos/shared-infra/packages/data/db') {
        return { execute: async () => [] };
    }
    return originalRequire.apply(this, arguments);
};

const AutofixProcessor = require('../processors/AutofixProcessor');
const StorageManager = require('../utils/StorageManager');
StorageManager.prototype.getJobSubfolder = (tenantId, jobId, folder) => {
    // We will set this dynamically during the test
    return process.env.TEST_DIR || require('os').tmpdir();
};
const storage = new StorageManager();

const REPORTS_DIR = path.join(__dirname, '../reports');

// Mock child_process and other dependencies
jest = { mock: () => {} }; // simple mock setup if needed
const { exec } = require('child_process');

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    const engineReportPath = path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase62a_engine_page_marks_fixes.json');
    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    
    console.log(`[TEST] Checking for Engine report at: ${engineReportPath}`);
    if (await fs.pathExists(engineReportPath)) {
        inputMode = 'ENGINE_REPORT';
        console.log(`[TEST] Found Engine report. Mode: ${inputMode}`);
    } else {
        console.log(`[TEST] Engine report not found. Mode: ${inputMode}`);
    }

    const scenarios = [
        {
            name: "1. ADD_CROP_MARKS applied on safe margin",
            mockEngineResult: {
                applied_fixes: [
                    {
                        fix_id: 'ADD_CROP_MARKS',
                        status: 'APPLIED',
                        safety_checks: { safe: true },
                        mark_geometry: { margin: '10mm' }
                    }
                ],
                skipped_fixes: [],
                failed_fixes: []
            }
        },
        {
            name: "2. ADD_CROP_MARKS skipped due to insufficient margin",
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [
                    {
                        fix_id: 'ADD_CROP_MARKS',
                        status: 'SKIPPED',
                        reason: 'INSUFFICIENT_MARGIN',
                        safety_checks: { safe: false },
                        mark_geometry: { margin: '1mm' }
                    }
                ],
                failed_fixes: []
            }
        },
        {
            name: "3. REMOVE_REGISTRATION_MARKS skipped due to unsafe removal",
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [
                    {
                        fix_id: 'REMOVE_REGISTRATION_MARKS',
                        status: 'SKIPPED',
                        reason: 'UNSAFE_REMOVAL'
                    }
                ],
                failed_fixes: []
            }
        },
        {
            name: "4. REMOVE_REGISTRATION_MARKS skipped because marks are inside TrimBox",
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [
                    {
                        fix_id: 'REMOVE_REGISTRATION_MARKS',
                        status: 'SKIPPED',
                        reason: 'MARKS_INSIDE_TRIM'
                    }
                ],
                failed_fixes: []
            }
        },
        {
            name: "5. NORMALIZE_PAGE_MARKS skipped/no action needed",
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [
                    {
                        fix_id: 'NORMALIZE_PAGE_MARKS',
                        status: 'SKIPPED',
                        reason: 'NO_ACTION_NEEDED'
                    }
                ],
                failed_fixes: []
            }
        },
        {
            name: "6. clean control no action",
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: []
            }
        },
        {
            name: "7. page mark APPLIED with certified.pdf artifact present",
            mockEngineResult: {
                applied_fixes: [
                    { fix_id: 'ADD_CROP_MARKS', status: 'APPLIED' }
                ],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true, // engine claims it, worker should block it
                standard_claimed: "PDF/X-4",
                pdfx_compliance_claimed: true
            }
        },
        {
            name: "8. standards overclaim regression",
            mockEngineResult: {
                applied_fixes: [
                    { fix_id: 'REMOVE_REGISTRATION_MARKS', status: 'APPLIED' },
                    { fix_id: 'VALIDATE_PDFX', status: 'APPLIED', validator_name: 'qpdf', validation_passed: true }
                ],
                skipped_fixes: [],
                failed_fixes: [],
                pdfx_compliance_claimed: true
            }
        },
        {
            name: "9. evidence preservation for geometry",
            mockEngineResult: {
                applied_fixes: [
                    { 
                        fix_id: 'ADD_CROP_MARKS', 
                        status: 'APPLIED',
                        mark_geometry: { trim_box: [0, 0, 100, 100], bleed_box: [-5, -5, 105, 105] },
                        safety_checks: { safe: true, conflicts: [] }
                    }
                ],
                skipped_fixes: [],
                failed_fixes: []
            }
        },
        {
            name: "10. artifact_trust review-required regression",
            mockEngineResult: {
                applied_fixes: [
                    { fix_id: 'NORMALIZE_PAGE_MARKS', status: 'APPLIED' }
                ],
                skipped_fixes: [],
                failed_fixes: [],
                review_required: false // engine says false, worker should force true
            }
        }
    ];

    const results = [];
    let smokePassed = true;

    // We'll mock standard engine response in AutofixProcessor
    const mockedEngineFactory = () => ({
        autofixPdf: async () => ({})
    });
    
    // Mock fs-extra and StorageManager paths
    const testDir = path.join(os.tmpdir(), `phase62b-test-${Date.now()}`);
    process.env.TEST_DIR = testDir;
    await fs.ensureDir(testDir);
    const mockInput = path.join(testDir, 'input.pdf');
    await fs.writeFile(mockInput, '%PDF-1.4\nTest');
    const mockOutput = path.join(testDir, 'mock_engine_output.pdf');
    await fs.writeFile(mockOutput, '%PDF-1.4\nTest Fixed');
    const mockSanitized = path.join(testDir, 'sanitized_input.pdf');
    await fs.writeFile(mockSanitized, '%PDF-1.4\nSanitized');

    // storage is mocked via prototype

    // Overwrite sanitizePdfForAutofix to skip real qpdf
    AutofixProcessor.sanitizePdfForAutofix = async () => mockInput;

    for (const scenario of scenarios) {
        console.log(`\n[TEST] Running scenario: ${scenario.name}`);
        
        // Setup current mock result
        currentEngineMockResult = {
            fixedPath: mockOutput,
            artifacts: { fixed_pdf: { path: mockOutput } },
            ...scenario.mockEngineResult
        };

        const job = {
            data: {
                jobId: 'job-123',
                tenantId: 'tenant-123',
                input: {
                    fileUrl: mockInput,
                    findings: [{ id: 'MISSING_CROP_MARKS' }] // dummy finding
                },
                fixes: ['ADD_CROP_MARKS'] // dummy requested fix
            },
            updateProgress: async () => {}
        };

        try {
            const result = await AutofixProcessor.process(job, console);
            
            const fixAuditPath = path.join(testDir, 'fix_audit.json');
            const deltaReportPath = path.join(testDir, 'delta_report.json');
            
            const audit = await fs.readJson(fixAuditPath);
            const delta = await fs.readJson(deltaReportPath);
            
            const gov = audit.page_marks_governance;
            const trust = audit.artifact_trust;
            
            let pass = true;
            let notes = [];

            if (!gov) { pass = false; notes.push("page_marks_governance missing in fix_audit.json"); }
            if (!delta.page_marks_governance) { pass = false; notes.push("page_marks_governance missing in delta_report.json"); }
            
            if (gov) {
                // Check review required enforcement
                if (scenario.name.includes("APPLIED") || gov.page_marks_fix_applied) {
                    if (!gov.review_required) { pass = false; notes.push("Review not required when fix applied"); }
                    if (gov.production_certified) { pass = false; notes.push("Production certified when fix applied"); }
                    if (gov.standard_certified) { pass = false; notes.push("Standard certified when fix applied"); }
                    if (trust.review_required !== true) { pass = false; notes.push("Artifact trust review_required not true"); }
                }

                // Unsafe skipped should preserve reason and evidence
                if (scenario.name.includes("skipped due to")) {
                    if (!gov.review_required_reasons.some(r => r.includes('_SKIPPED_UNSAFE'))) {
                        pass = false; notes.push("Missing _SKIPPED_UNSAFE reason");
                    }
                }
                
                // Geometry evidence
                if (scenario.name.includes("evidence preservation")) {
                    const evidenceObj = gov.evidence && gov.evidence['ADD_CROP_MARKS'];
                    if (!evidenceObj || !evidenceObj.mark_geometry || !evidenceObj.safety_checks) {
                        pass = false; notes.push("Geometry evidence not preserved");
                    }
                }
            }
            
            if (scenario.name.includes("standards overclaim regression")) {
                if (audit.standards_certification_governance.pdfx_compliance_claimed) {
                    pass = false; notes.push("PDF/X compliance falsely claimed after page mark fix");
                }
            }

            if (!pass) {
                smokePassed = false;
                console.log(`Failed gov:`, gov);
                console.log(`Failed trust:`, trust);
            }

            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: result.status,
                page_marks_governance: gov || {},
                artifact_trust: trust || {},
                evidence_present: Object.keys(gov?.evidence || {}).length > 0,
                production_certified: trust?.production_certified,
                standard_certified: trust?.standard_certified,
                pdfx_compliance_claimed: trust?.pdfx_compliance_claimed,
                review_required: trust?.review_required,
                pass,
                notes: notes.length ? notes.join(", ") : "OK"
            });
            
        } catch (err) {
            console.error(err);
            smokePassed = false;
            results.push({
                scenario: scenario.name,
                status: 'ERROR',
                pass: false,
                notes: err.message
            });
        }
    }

    // Generate Reports
    const reportJsonPath = path.join(REPORTS_DIR, 'phase62b_worker_page_marks_policy.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase62b_worker_page_marks_policy.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        smoke_passed: smokePassed,
        input_mode: inputMode,
        results
    }, { spaces: 2 });

    let mdContent = `# Phase 62B - Worker Page Marks Policy Regression\n\n`;
    mdContent += `**Timestamp:** ${new Date().toISOString()}\n`;
    mdContent += `**Input Mode:** ${inputMode}\n`;
    mdContent += `**Status:** ${smokePassed ? 'PASS' : 'FAIL'}\n\n`;

    mdContent += `## Results\n\n`;
    for (const res of results) {
        mdContent += `### ${res.scenario}\n`;
        mdContent += `- **Pass:** ${res.pass}\n`;
        mdContent += `- **Notes:** ${res.notes}\n`;
        mdContent += `- **Review Required:** ${res.review_required}\n`;
        mdContent += `- **Production Certified:** ${res.production_certified}\n`;
        mdContent += `- **Standard Certified:** ${res.standard_certified}\n`;
        mdContent += `- **Evidence Present:** ${res.evidence_present}\n\n`;
    }

    await fs.writeFile(reportMdPath, mdContent);
    console.log(`[TEST] Reports generated at ${REPORTS_DIR}`);

    if (!smokePassed) {
        console.error(`[TEST] Smoke tests FAILED.`);
        process.exit(1);
    } else {
        console.log(`[TEST] Smoke tests PASSED.`);
    }
}

runSmokeTest().catch(err => {
    console.error(err);
    process.exit(1);
});
