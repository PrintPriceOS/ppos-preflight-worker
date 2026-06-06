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

const engineReportPath = process.env.PHASE56E_ENGINE_REPORT || path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase56e_engine_artifact_trust_regression.json');

async function runTest(scenarioDef, index) {
    console.log(`\n--- Running Scenario: ${scenarioDef.scenario} ---`);
    
    // Map scenario to mock engine result
    const mockResult = {
        ok: true,
        fixedPath: path.join(os.tmpdir(), `engine_fixed_${index}.pdf`),
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [],
        fix_results: [],
        review_required: scenarioDef.review_required || false,
        production_certified: scenarioDef.production_certified || false,
        standard_certified: scenarioDef.standard_certified || false,
        pdfx_compliance_claimed: false,
        detector_gap: false,
        validator_gap: false
    };

    // Construct evidence and findings based on scenario string
    let sourceFindings = [];
    if (scenarioDef.scenario.includes('visual governance')) {
        sourceFindings.push({ id: 'EXCESSIVE_TAC' });
    }
    if (scenarioDef.scenario.includes('font/color/image/transparency review blocker')) {
        sourceFindings.push({ id: 'NON_EMBEDDED_FONTS' });
    }
    if (scenarioDef.scenario.includes('complete validator evidence')) {
        mockResult.validator_name = "verapdf";
        mockResult.validator_version = "1.24";
        mockResult.validation_performed = true;
        mockResult.validation_passed = true;
        mockResult.standard_detected = "PDF/X-4";
        mockResult.validation_report_available = true;
        mockResult.pdfx_compliance_claimed = true;
    }
    if (scenarioDef.scenario.includes('OutputIntent injected')) {
        mockResult.applied_fixes.push({ fix_id: 'INJECT_OUTPUT_INTENT', risk_level: 'LOW' });
    }
    if (scenarioDef.scenario.includes('destructive visual fix applied')) {
        mockResult.applied_fixes.push({ fix_id: 'FLATTEN_TRANSPARENCY', risk_level: 'HIGH', requires_human_review: true });
        sourceFindings.push({ id: 'TRANSPARENCY_PRESENT' });
    }
    if (scenarioDef.scenario.includes('detector_gap / validator_gap')) {
        mockResult.detector_gap = true;
        mockResult.validator_gap = true;
    }
    if (scenarioDef.scenario.includes('artifact role ordering')) {
        sourceFindings.push({ id: 'EXCESSIVE_TAC' }); // causes review_required
    }
    
    // Some tests expect certified.pdf name
    if (scenarioDef.input_artifact === 'certified.pdf') {
        mockResult.fixedPath = path.join(os.tmpdir(), `certified.pdf`);
    } else {
        mockResult.fixedPath = path.join(os.tmpdir(), `engine_fixed_${index}.pdf`);
    }

    global.engineMock = {
        autofixPdf: async () => mockResult
    };

    const jobId = `job-56e-${index}-${Date.now()}`;
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
            findings: sourceFindings,
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
    
    const at = fixAudit.artifact_trust;
    if (!at) throw new Error("artifact_trust missing in fix_audit.json");
    if (!deltaReport.artifact_trust) throw new Error("artifact_trust missing in delta_report.json");

    let pass = true;
    let notes = [];

    const assertValue = (name, actual, expected) => {
        if (actual !== expected) {
            pass = false;
            notes.push(`${name} was ${actual}, expected ${expected}`);
        }
    };

    // Validations based on scenario string
    if (scenarioDef.scenario.includes('certified.pdf filename only') && !scenarioDef.scenario.includes('review blocker') && !scenarioDef.scenario.includes('production-certified') && !scenarioDef.scenario.includes('standards-certified')) {
        assertValue('production_certified', at.production_certified, false);
        assertValue('standard_certified', at.standard_certified, false);
        assertValue('customer_visible', at.customer_visible, false);
        if (at.primary_artifact_type === 'certified_pdf') {
            pass = false;
            notes.push("certified_pdf became primary by filename alone");
        }
    }

    if (scenarioDef.scenario.includes('fixed.pdf with no blockers')) {
        // fixed.pdf can be primary
        if (at.primary_artifact_type !== 'fixed_pdf') {
            pass = false;
            notes.push(`primary_artifact_type is ${at.primary_artifact_type}, expected fixed_pdf`);
        }
        assertValue('standard_certified', at.standard_certified, false);
    }

    if (scenarioDef.scenario.includes('review.pdf required due to visual governance')) {
        assertValue('review_required', at.review_required, true);
        assertValue('production_certified', at.production_certified, false);
        if (at.primary_artifact_type !== 'review_pdf') {
            pass = false;
            notes.push(`primary_artifact_type is ${at.primary_artifact_type}, expected review_pdf`);
        }
        if (!at.blocked_by_governance_domains.includes('color')) {
            pass = false;
            notes.push(`blocked_by_governance_domains missing color: ${JSON.stringify(at.blocked_by_governance_domains)}`);
        }
    }

    if (scenarioDef.scenario.includes('certified.pdf with font/color/image/transparency review blocker')) {
        assertValue('certified_pdf_allowed', at.certified_pdf_allowed, false);
        if (at.primary_artifact_type === 'certified_pdf') {
            pass = false;
            notes.push(`certified_pdf became primary incorrectly`);
        }
        assertValue('customer_visible', at.customer_visible, false);
    }

    if (scenarioDef.scenario.includes('production-certified but not standards-certified')) {
        assertValue('production_certified', at.production_certified, true);
        assertValue('standard_certified', at.standard_certified, false);
        assertValue('pdfx_compliance_claimed', at.pdfx_compliance_claimed, false);
    }

    if (scenarioDef.scenario.includes('standards-certified with complete validator evidence')) {
        assertValue('standard_certified', at.standard_certified, true);
        assertValue('pdfx_compliance_claimed', at.pdfx_compliance_claimed, true);
    }

    if (scenarioDef.scenario.includes('OutputIntent injected')) {
        assertValue('pdfx_compliance_claimed', at.pdfx_compliance_claimed, false);
        assertValue('standard_certified', at.standard_certified, false);
    }

    if (scenarioDef.scenario.includes('destructive visual fix applied')) {
        assertValue('trust_level', at.trust_level, 'FIXED_REVIEW_REQUIRED');
        assertValue('production_certified', at.production_certified, false);
        assertValue('certified_pdf_allowed', at.certified_pdf_allowed, false);
    }

    if (scenarioDef.scenario.includes('detector_gap / validator_gap metadata')) {
        if (!fixAudit.standards_certification_governance.detector_gap || !fixAudit.standards_certification_governance.validator_gap) {
            pass = false;
            notes.push("detector_gap or validator_gap not preserved");
        }
        assertValue('standard_certified', at.standard_certified, false);
    }

    if (scenarioDef.scenario.includes('artifact role ordering')) {
        assertValue('review_required', at.review_required, true);
        if (at.primary_artifact_type !== 'review_pdf') {
            pass = false;
            notes.push(`Expected primary review_pdf, got ${at.primary_artifact_type}`);
        }
    }

    if (pass) {
        console.log(`  => PASS`);
    } else {
        console.log(`  => FAIL: ${notes.join('; ')}`);
        throw new Error(`Smoke Test Failed for scenario: ${scenarioDef.scenario}`);
    }

    return {
        scenario: scenarioDef.scenario,
        input_engine_artifact_trust: scenarioDef.artifact_trust,
        worker_artifact_trust: at.trust_level,
        fix_audit_present: true,
        delta_report_present: true,
        primary_artifact_type: at.primary_artifact_type,
        production_certified: at.production_certified,
        standard_certified: at.standard_certified,
        customer_visible: at.customer_visible,
        blocked_by_governance_domains: at.blocked_by_governance_domains,
        certification_labels: at.certification_labels,
        pass: pass,
        notes: notes.join('; ') || 'As expected'
    };
}

async function main() {
    console.log("Loading Engine Report from:", engineReportPath);
    let engineData = [];
    try {
        const raw = await fsPromises.readFile(engineReportPath, 'utf8');
        engineData = JSON.parse(raw);
    } catch(e) {
        console.error("Could not load engine report:", e.message);
        process.exit(1);
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
                scenario: engineData[i].scenario,
                pass: false,
                notes: e.message
            });
        }
    }

    const reportDir = path.resolve(__dirname, '../reports');
    await fsPromises.mkdir(reportDir, { recursive: true });

    const jsonReportPath = path.join(reportDir, 'phase56e_worker_artifact_trust_regression.json');
    await fsPromises.writeFile(jsonReportPath, JSON.stringify(reportResults, null, 2));

    const mdReportPath = path.join(reportDir, 'phase56e_worker_artifact_trust_regression.md');
    let mdContent = `# Phase 56E.2 Worker Artifact Trust Regression\n\n`;
    reportResults.forEach(r => {
        mdContent += `## ${r.scenario}\n`;
        mdContent += `- Pass: ${r.pass ? '✅' : '❌'}\n`;
        if (r.primary_artifact_type) mdContent += `- Primary Artifact Type: ${r.primary_artifact_type}\n`;
        if (r.production_certified !== undefined) mdContent += `- Production Certified: ${r.production_certified}\n`;
        if (r.standard_certified !== undefined) mdContent += `- Standard Certified: ${r.standard_certified}\n`;
        if (r.customer_visible !== undefined) mdContent += `- Customer Visible: ${r.customer_visible}\n`;
        if (r.blocked_by_governance_domains) mdContent += `- Blocked by: ${r.blocked_by_governance_domains.join(', ')}\n`;
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
