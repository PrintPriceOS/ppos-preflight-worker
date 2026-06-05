const { createStandardEngine } = require('@ppos/preflight-engine');
const AutofixProcessor = require('../processors/AutofixProcessor');
const fs = require('fs-extra');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '../reports');
const REPORT_JSON = path.join(REPORTS_DIR, 'phase53b_worker_transparency_overprint_policy.json');
const REPORT_MD = path.join(REPORTS_DIR, 'phase53b_worker_transparency_overprint_policy.md');

async function runScenarios() {
    const testStorageDir = path.join(__dirname, '../scratch/smoke-storage');
    process.env.PPOS_UPLOADS_DIR = testStorageDir;
    await fs.ensureDir(REPORTS_DIR);

    const baseContext = {
        jobId: 'smoke-job-53b',
        tenantId: 'tenant-smoke',
        fileUrl: path.join(__dirname, '../smoke-check.js'), // arbitrary file for mock
        policyProfile: 'standard',
        trace: { requestId: 'smoke-req-53b' }
    };

    const scenarios = [
        {
            name: "1. TRANSPARENCY_PRESENT finding",
            requested_fixes: [],
            findings: [{ id: 'TRANSPARENCY_PRESENT' }],
            mockRepairs: [],
            expected: { review_required: true, production_certified: false, review_reasons_includes: 'TRANSPARENCY_PRESENT' }
        },
        {
            name: "2. SOFT_MASK_PRESENT + BLEND_MODE_PRESENT findings",
            requested_fixes: [],
            findings: [{ id: 'SOFT_MASK_PRESENT' }, { id: 'BLEND_MODE_PRESENT' }],
            mockRepairs: [],
            expected: { review_required: true, production_certified: false, governance_soft_mask: true, governance_blend_mode: true }
        },
        {
            name: "3. OVERPRINT_PRESENT finding",
            requested_fixes: [],
            findings: [{ id: 'OVERPRINT_PRESENT' }],
            mockRepairs: [],
            expected: { review_required: true, production_certified: false, review_reasons_includes: 'OVERPRINT_PRESENT' }
        },
        {
            name: "4. FLATTEN_TRANSPARENCY unsupported",
            requested_fixes: ['FLATTEN_TRANSPARENCY'],
            findings: [{ id: 'TRANSPARENCY_PRESENT' }],
            mockRepairs: [{ code: 'FLATTEN_TRANSPARENCY', status: 'UNSUPPORTED' }],
            expected: { skipped_includes: 'FLATTEN_TRANSPARENCY', production_safe: false, review_required: true, production_certified: false }
        },
        {
            name: "5. FLATTEN_OVERPRINT unsupported",
            requested_fixes: ['FLATTEN_OVERPRINT'],
            findings: [{ id: 'OVERPRINT_PRESENT' }],
            mockRepairs: [{ code: 'FLATTEN_OVERPRINT', status: 'UNSUPPORTED' }],
            expected: { skipped_includes: 'FLATTEN_OVERPRINT', review_required: true, production_certified: false }
        },
        {
            name: "6. CONVERT_TO_PDFX_TRANSPARENCY_SAFE unsupported",
            requested_fixes: ['CONVERT_TO_PDFX_TRANSPARENCY_SAFE'],
            findings: [{ id: 'UNSUPPORTED_TRANSPARENCY_FOR_PDFX' }],
            mockRepairs: [{ code: 'CONVERT_TO_PDFX_TRANSPARENCY_SAFE', status: 'UNSUPPORTED' }],
            expected: { skipped_includes: 'CONVERT_TO_PDFX_TRANSPARENCY_SAFE', pdfx_claimed: false }
        },
        {
            name: "7. Engine incorrectly reports unsupported fix as APPLIED",
            requested_fixes: ['RASTERIZE_TRANSPARENCY'],
            findings: [],
            mockRepairs: [{ code: 'RASTERIZE_TRANSPARENCY', status: 'APPLIED', implemented: false }],
            expected: { applied_includes_false: 'RASTERIZE_TRANSPARENCY', skipped_includes: 'RASTERIZE_TRANSPARENCY', moved_to_skipped: true }
        },
        {
            name: "8. Future applied visual rewrite fix",
            requested_fixes: ['FLATTEN_PDF'],
            findings: [],
            mockRepairs: [{ code: 'FLATTEN_PDF', status: 'APPLIED', visually_sensitive: true }],
            expected: { review_required: true, production_certified: false, certified_pdf_allowed: false }
        },
        {
            name: "9. Findings never applied",
            requested_fixes: [],
            findings: [{ id: 'TRANSPARENCY_PRESENT' }, { id: 'RASTERIZATION_RISK' }],
            mockRepairs: [{ code: 'TRANSPARENCY_PRESENT', status: 'APPLIED' }, { code: 'RASTERIZATION_RISK', status: 'APPLIED' }],
            expected: { applied_includes_false: 'TRANSPARENCY_PRESENT', moved_to_review_reason: true }
        }
    ];

    const results = [];

    // Mock engine
    const engineAutofixOrig = createStandardEngine().autofixPdf;

    for (const scenario of scenarios) {
        // We will monkey patch the require cache or just override
        const engine = createStandardEngine();
        engine.autofixPdf = async (input, payload) => {
            return {
                ok: true,
                fixedPath: input, // Fake
                repairs: scenario.mockRepairs,
                applied_fixes: scenario.mockRepairs.filter(r => r.status === 'APPLIED'),
                skipped_fixes: scenario.mockRepairs.filter(r => r.status === 'SKIPPED' || r.status === 'UNSUPPORTED'),
                failed_fixes: scenario.mockRepairs.filter(r => r.status === 'FAILED'),
                review_required: false,
                production_certified: true
            };
        };

        const reqCache = require.cache[require.resolve('@ppos/preflight-engine')];
        reqCache.exports = {
            createStandardEngine: () => engine
        };

        delete require.cache[require.resolve('../processors/AutofixProcessor')];
        const AutofixProcessorMocked = require('../processors/AutofixProcessor');

        const job = {
            data: {
                ...baseContext,
                requested_fixes: scenario.requested_fixes,
                findings: scenario.findings,
                input: { fileUrl: baseContext.fileUrl }
            },
            updateProgress: async () => {}
        };

        try {
            const tempDir = path.join(testStorageDir, 'tenants', baseContext.tenantId, 'jobs', baseContext.jobId, 'output');
            await fs.ensureDir(tempDir);
            
            const res = await AutofixProcessorMocked.process(job, { info: () => {}, warn: () => {}, error: () => {} });
            
            const fixAuditPath = path.join(tempDir, 'fix_audit.json');
            const deltaReportPath = path.join(tempDir, 'delta_report.json');
            
            let fixAudit = { applied_fixes: [], skipped_fixes: [], review_required_reasons: [] };
            let deltaReport = { transparency_overprint_governance: {} };

            if (await fs.pathExists(fixAuditPath)) {
                fixAudit = await fs.readJson(fixAuditPath);
            }
            if (await fs.pathExists(deltaReportPath)) {
                deltaReport = await fs.readJson(deltaReportPath);
            }

            let passed = true;
            let errors = [];

            if (scenario.expected.review_required !== undefined && fixAudit.review_required !== scenario.expected.review_required) {
                passed = false;
                errors.push(`Expected review_required=${scenario.expected.review_required}, got ${fixAudit.review_required}`);
            }
            if (scenario.expected.production_certified !== undefined && fixAudit.production_certified !== scenario.expected.production_certified) {
                passed = false;
                errors.push(`Expected production_certified=${scenario.expected.production_certified}, got ${fixAudit.production_certified}`);
            }
            if (scenario.expected.review_reasons_includes && !fixAudit.review_required_reasons.includes(scenario.expected.review_reasons_includes)) {
                passed = false;
                errors.push(`Expected review_required_reasons to include ${scenario.expected.review_reasons_includes}`);
            }
            if (scenario.expected.governance_soft_mask && !deltaReport.transparency_overprint_governance.soft_masks_present) {
                passed = false;
                errors.push(`Expected governance_soft_mask=true`);
            }
            if (scenario.expected.governance_blend_mode && !deltaReport.transparency_overprint_governance.blend_modes_present) {
                passed = false;
                errors.push(`Expected governance_blend_mode=true`);
            }
            if (scenario.expected.skipped_includes && !fixAudit.skipped_fixes.some(f => (f.code || f.fix_id) === scenario.expected.skipped_includes)) {
                passed = false;
                errors.push(`Expected skipped_fixes to include ${scenario.expected.skipped_includes}`);
            }
            if (scenario.expected.pdfx_claimed !== undefined && deltaReport.transparency_overprint_governance.pdfx_compliance_claimed !== scenario.expected.pdfx_claimed) {
                passed = false;
                errors.push(`Expected pdfx_compliance_claimed=${scenario.expected.pdfx_claimed}, got ${deltaReport.transparency_overprint_governance.pdfx_compliance_claimed}`);
            }
            if (scenario.expected.applied_includes_false && fixAudit.applied_fixes.some(f => (f.code || f.fix_id) === scenario.expected.applied_includes_false)) {
                passed = false;
                errors.push(`Expected applied_fixes NOT to include ${scenario.expected.applied_includes_false}`);
            }
            if (scenario.expected.moved_to_skipped && !fixAudit.skipped_fixes.some(f => f.moved_from_applied_to_skipped)) {
                passed = false;
                errors.push(`Expected moved_from_applied_to_skipped=true in skipped_fixes`);
            }
            if (scenario.expected.certified_pdf_allowed !== undefined && deltaReport.transparency_overprint_governance.certified_pdf_allowed !== scenario.expected.certified_pdf_allowed) {
                passed = false;
                errors.push(`Expected certified_pdf_allowed=${scenario.expected.certified_pdf_allowed}`);
            }
            if (scenario.expected.moved_to_review_reason && !fixAudit.review_required_reasons.some(r => r.moved_from_applied_to_review_reason)) {
                passed = false;
                errors.push(`Expected moved_from_applied_to_review_reason=true in review_required_reasons`);
            }

            results.push({
                scenario: scenario.name,
                requested_fixes: scenario.requested_fixes,
                findings: scenario.findings,
                applied_fixes: (fixAudit.applied_fixes || []).map(f => f.fix_id || f.code),
                skipped_fixes: (fixAudit.skipped_fixes || []).map(f => f.fix_id || f.code),
                failed_fixes: (fixAudit.failed_fixes || []).map(f => f.fix_id || f.code),
                transparency_overprint_governance: deltaReport.transparency_overprint_governance,
                review_required: fixAudit.review_required,
                production_certified: fixAudit.production_certified,
                artifact_policy: fixAudit.artifact_policy,
                certified_pdf_allowed: deltaReport.transparency_overprint_governance.certified_pdf_allowed,
                pdfx_compliance_claimed: deltaReport.transparency_overprint_governance.pdfx_compliance_claimed,
                pass: passed,
                errors: errors.length ? errors : undefined
            });
            
            // cleanup tempdir
            await fs.remove(tempDir);

        } catch (err) {
            results.push({
                scenario: scenario.name,
                pass: false,
                errors: [err.message]
            });
        }
    }

    const reqCache = require.cache[require.resolve('@ppos/preflight-engine')];
    reqCache.exports.createStandardEngine = createStandardEngine; // restore

    const reportJson = {
        phase: "53B",
        name: "Worker Transparency / Overprint Artifact Policy",
        timestamp: new Date().toISOString(),
        scenarios: results,
        pass: results.every(r => r.pass)
    };

    await fs.writeJson(REPORT_JSON, reportJson, { spaces: 2 });

    let md = `# Phase 53B Worker Transparency / Overprint Artifact Policy Smoke Test\n\n`;
    md += `**Result:** ${reportJson.pass ? '✅ PASS' : '❌ FAIL'}\n\n`;

    for (const r of results) {
        md += `### ${r.scenario}\n`;
        md += `- **Pass:** ${r.pass ? '✅' : '❌'}\n`;
        if (r.errors) {
            md += `- **Errors:**\n${r.errors.map(e => `  - ${e}`).join('\n')}\n`;
        }
        md += `- **Review Required:** ${r.review_required}\n`;
        md += `- **Production Certified:** ${r.production_certified}\n`;
        md += `- **PDF/X Claimed:** ${r.pdfx_compliance_claimed}\n`;
        md += `- **Governance:** \n\`\`\`json\n${JSON.stringify(r.transparency_overprint_governance, null, 2)}\n\`\`\`\n\n`;
    }

    await fs.writeFile(REPORT_MD, md);

    console.log(`Smoke test completed. Pass: ${reportJson.pass}`);
    if (!reportJson.pass) process.exit(1);
}

runScenarios().catch(err => {
    console.error(err);
    process.exit(1);
});
