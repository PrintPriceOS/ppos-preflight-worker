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
                return path.join(os.tmpdir(), 'ppos-test-phase56b', tenantId, jobId, sub);
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

let testResults = [];

async function runTest(scenario, jobPayload, engineMockResult, expectedTrustState) {
    console.log(`\n--- Running Scenario: ${scenario} ---`);
    
    global.engineMock = {
        autofixPdf: async () => engineMockResult
    };

    const jobId = `test-job-${Date.now()}`;
    const tenantId = 'test-tenant';
    const tempDir = path.join(os.tmpdir(), 'ppos-test-phase56b', tenantId, jobId, 'temp');
    const outputDir = path.join(os.tmpdir(), 'ppos-test-phase56b', tenantId, jobId, 'output');
    
    await fsPromises.mkdir(tempDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    
    const inputPdf = path.join(tempDir, 'input.pdf');
    await fsPromises.writeFile(inputPdf, 'dummy pdf content');

    // Emulate that engine returns a specific artifacts object/path
    const fixedPath = path.join(outputDir, 'engine_fixed.pdf');
    if (engineMockResult.fixedPath || engineMockResult.artifacts?.certified_pdf?.path || engineMockResult.applied_fixes?.length >= 0) {
        await fsPromises.writeFile(fixedPath, 'dummy fixed pdf');
        engineMockResult.fixedPath = fixedPath;
    }

    const job = {
        data: {
            jobId,
            tenantId,
            input: {
                fileUrl: inputPdf,
                fixes: jobPayload.fixes || ['REBUILD_TRIMBOX']
            },
            ...jobPayload
        },
        updateProgress: async () => {}
    };

    const logger = {
        info: (...args) => {},
        warn: (...args) => {},
        error: (...args) => console.error(...args)
    };

    let passed = false;
    let notes = [];
    let artifactTrust = null;
    let availableArtifacts = [];

    try {
        const result = await AutofixProcessor.process(job, logger);
        
        const fixAuditPath = path.join(outputDir, 'fix_audit.json');
        const fixAuditStr = await fsPromises.readFile(fixAuditPath, 'utf8');
        const fixAudit = JSON.parse(fixAuditStr);
        
        artifactTrust = fixAudit.artifact_trust;
        availableArtifacts = Object.keys(result.artifacts);

        // Validation
        if (!artifactTrust) throw new Error('artifact_trust object missing from fix_audit.json');
        
        for (const [key, value] of Object.entries(expectedTrustState)) {
            if (artifactTrust[key] !== value) {
                throw new Error(`Expected artifact_trust.${key}=${value}, got ${artifactTrust[key]}`);
            }
        }

        // Specific assertions for Phase 56B
        if (artifactTrust.primary_artifact_filename && artifactTrust.primary_artifact_type === 'certified_pdf' && artifactTrust.review_required) {
            throw new Error(`certified_pdf became primary while review_required=true`);
        }
        
        if (artifactTrust.customer_visible && artifactTrust.review_required) {
             throw new Error(`customer_visible=true while review_required=true`);
        }

        passed = true;
        console.log(`Scenario ${scenario} PASS`);
    } catch (e) {
        console.error(`Scenario ${scenario} FAIL: ${e.message}`);
        notes.push(e.message);
    }

    testResults.push({
        scenario,
        available_artifacts: availableArtifacts,
        artifact_trust: artifactTrust,
        primary_artifact_type: artifactTrust?.primary_artifact_type || null,
        production_certified: artifactTrust?.production_certified || false,
        standard_certified: artifactTrust?.standard_certified || false,
        customer_visible: artifactTrust?.customer_visible || false,
        certified_pdf_allowed: artifactTrust?.certified_pdf_allowed || false,
        blocked_by_governance_domains: artifactTrust?.blocked_by_governance_domains || [],
        certification_labels: artifactTrust?.certification_labels || [],
        pass: passed,
        notes
    });
}

async function main() {
    // 1. certified.pdf filename only
    // Engine output says it produced certified.pdf, but no standards evidence and no production governance explicitly allowed it.
    await runTest('1. certified.pdf filename only', {}, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        artifacts: { certified_pdf: { path: 'dummy' } },
        production_certified: false,
        review_required: false
    }, {
        production_certified: false,
        standard_certified: false,
        customer_visible: false,
        primary_artifact_type: 'fixed_pdf', // fallback because not certified
        certified_pdf_allowed: false
    });

    // 2. fixed.pdf no blockers
    await runTest('2. fixed.pdf no blockers', {}, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: false
    }, {
        trust_level: 'PRODUCTION_CERTIFIED',
        standard_certified: false,
        primary_artifact_type: 'certified_pdf',
        production_certified: true,
        customer_visible: true
    });

    // 3. review.pdf with color review required
    await runTest('3. review.pdf with color review required', {
        findings: [{ id: 'EXCESSIVE_TAC' }]
    }, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: false,
        review_required: true,
        review_required_reasons: ['EXCESSIVE_TAC']
    }, {
        trust_level: 'FIXED_REVIEW_REQUIRED',
        production_certified: false,
        primary_artifact_type: 'review_pdf'
    });

    // 4. certified.pdf with font review required
    await runTest('4. certified.pdf with font review required', {
        findings: [{ id: 'NON_EMBEDDED_FONTS' }]
    }, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true, // Engine claims true but font finding overrides
        review_required: true,
        artifacts: { certified_pdf: { path: 'dummy' } }
    }, {
        certified_pdf_allowed: false,
        primary_artifact_type: 'review_pdf',
        production_certified: false
    });

    // 5. certified.pdf with valid production governance but no standards evidence
    await runTest('5. certified.pdf with valid production governance but no standards evidence', {}, {
        applied_fixes: [{ fix_id: 'REBUILD_TRIMBOX' }],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: false
    }, {
        production_certified: true,
        standard_certified: false,
        pdfx_compliance_claimed: false,
        trust_level: 'PRODUCTION_CERTIFIED'
    });

    // 6. certified.pdf with complete standards validator evidence
    await runTest('6. certified.pdf with complete standards validator evidence', {}, {
        applied_fixes: [{
            fix_id: 'VALIDATE_PDFX',
            status: 'APPLIED',
            validation_passed: true,
            validation_performed: true,
            validator_name: 'VeraPDF',
            validator_version: '1.20',
            standard_detected: 'PDF/X-4',
            validation_report_available: true
        }],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: false
    }, {
        standard_certified: true,
        trust_level: 'STANDARD_CERTIFIED',
        customer_visible: true,
        primary_artifact_type: 'certified_pdf'
    });

    // 7. OutputIntent injected
    await runTest('7. OutputIntent injected', {}, {
        applied_fixes: [{ fix_id: 'INJECT_OUTPUT_INTENT' }],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: false
    }, {
        standard_certified: false,
        pdfx_compliance_claimed: false
    });

    // 8. destructive transparency/image/color fix applied
    await runTest('8. destructive transparency/image/color fix applied', {}, {
        applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY' }],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: false
    }, {
        trust_level: 'FIXED_REVIEW_REQUIRED',
        production_certified: false,
        certified_pdf_allowed: false
    });

    // 9. detector_gap / validator_gap metadata
    await runTest('9. detector_gap / validator_gap metadata', { validator_gap: true }, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: false
    }, {
        standard_certified: false
    });

    // 10. synthetic false overclaim
    await runTest('10. synthetic false overclaim', {}, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: false,
        standard_certified: true,
        pdfx_compliance_claimed: true
    }, {
        standard_certified: false,
        pdfx_compliance_claimed: false,
        review_required: true
    });

    // 11. artifact ordering (review_required=true ensures review_pdf is primary over certified_pdf)
    await runTest('11. artifact ordering', {
        findings: [{ id: 'EXCESSIVE_TAC' }]
    }, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: true,
        artifacts: { certified_pdf: { path: 'dummy' } }
    }, {
        primary_artifact_type: 'review_pdf'
    });

    // 12. Operator Approval with Standards Validation Missing
    await runTest('12. operator_approved=true over visual blockers but fails standards', {
        operator_approved: true,
        findings: [{ id: 'EXCESSIVE_TAC' }]
    }, {
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        production_certified: true,
        review_required: true,
        pdfx_compliance_claimed: true // Triggers STANDARD_CLAIM_WITHOUT_VALIDATOR_EVIDENCE
    }, {
        production_certified: false,
        review_required: true,
        standard_certified: false
    });

    // Write reports
    const reportDir = path.join(__dirname, '../reports');
    await fsPromises.mkdir(reportDir, { recursive: true });
    
    await fsPromises.writeFile(
        path.join(reportDir, 'phase56b_worker_artifact_trust_policy.json'),
        JSON.stringify({
            timestamp: new Date().toISOString(),
            results: testResults
        }, null, 2)
    );

    let mdReport = '# Phase 56B - Worker Final Artifact Trust Policy Report\n\n';
    testResults.forEach(r => {
        mdReport += `## Scenario: ${r.scenario}\n`;
        mdReport += `- Pass: ${r.pass}\n`;
        mdReport += `- Primary Artifact Type: ${r.primary_artifact_type}\n`;
        mdReport += `- Trust Level: ${r.artifact_trust?.trust_level}\n`;
        mdReport += `- Production Certified: ${r.production_certified}\n`;
        mdReport += `- Standard Certified: ${r.standard_certified}\n`;
        mdReport += `- Customer Visible: ${r.customer_visible}\n`;
        mdReport += `- Certified PDF Allowed: ${r.certified_pdf_allowed}\n`;
        mdReport += `- Blocked by: ${r.blocked_by_governance_domains.join(', ')}\n`;
        if (r.notes.length > 0) {
            mdReport += `- Notes: ${r.notes.join('; ')}\n`;
        }
        mdReport += '\n';
    });

    await fsPromises.writeFile(
        path.join(reportDir, 'phase56b_worker_artifact_trust_policy.md'),
        mdReport
    );

    console.log(`\nReports generated in ${reportDir}`);
    
    const failed = testResults.filter(r => !r.pass);
    if (failed.length > 0) {
        console.error(`${failed.length} tests failed.`);
        process.exit(1);
    } else {
        console.log('All tests passed.');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
