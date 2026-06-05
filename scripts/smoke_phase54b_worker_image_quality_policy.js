const { createStandardEngine } = require('@ppos/preflight-engine');
const AutofixProcessor = require('../processors/AutofixProcessor');
const fs = require('fs-extra');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '../reports');
const REPORT_JSON = path.join(REPORTS_DIR, 'phase54b_worker_image_quality_policy.json');
const REPORT_MD = path.join(REPORTS_DIR, 'phase54b_worker_image_quality_policy.md');

async function runScenarios() {
    const testStorageDir = path.join(__dirname, '../scratch/smoke-storage-54b');
    process.env.PPOS_UPLOADS_DIR = testStorageDir;
    await fs.ensureDir(REPORTS_DIR);

    const baseContext = {
        jobId: 'smoke-job-54b',
        tenantId: 'tenant-smoke',
        fileUrl: path.join(__dirname, '../smoke-check.js'), // arbitrary file for mock
        policyProfile: 'standard',
        trace: { requestId: 'smoke-req-54b' }
    };

    const scenarios = [
        {
            name: "1. LOW_RES_IMAGES finding.",
            requested_fixes: [],
            findings: [{ id: 'LOW_RES_IMAGES' }],
            mockRepairs: [],
            expected: { review_required: true, production_certified: false, review_reasons_includes: 'LOW_RES_IMAGES' }
        },
        {
            name: "2. JPEG_ARTIFACTS finding.",
            requested_fixes: [],
            findings: [{ id: 'JPEG_ARTIFACTS' }],
            mockRepairs: [],
            expected: { review_required: true, production_certified: false, review_reasons_includes: 'JPEG_ARTIFACTS' }
        },
        {
            name: "3. EXCESSIVE_RESOLUTION warning.",
            requested_fixes: [],
            findings: [{ id: 'EXCESSIVE_RESOLUTION' }],
            mockRepairs: [],
            expected: { review_required: false, production_certified: true, warning_preserved: true }
        },
        {
            name: "4. BITMAP_TEXT_RISK critical finding.",
            requested_fixes: [],
            findings: [{ id: 'BITMAP_TEXT_RISK' }],
            mockRepairs: [],
            expected: { review_required: true, production_certified: false, highest_risk: 'CRITICAL', review_reasons_includes: 'BITMAP_TEXT_RISK' }
        },
        {
            name: "5. RASTERIZED_VECTOR_RISK critical finding.",
            requested_fixes: [],
            findings: [{ id: 'RASTERIZED_VECTOR_RISK' }],
            mockRepairs: [],
            expected: { review_required: true, production_certified: false, highest_risk: 'CRITICAL', review_reasons_includes: 'RASTERIZED_VECTOR_RISK' }
        },
        {
            name: "6. UPSCALE_LOW_RES_IMAGES unsupported.",
            requested_fixes: ['UPSCALE_LOW_RES_IMAGES'],
            findings: [{ id: 'LOW_RES_IMAGES' }],
            mockRepairs: [{ code: 'UPSCALE_LOW_RES_IMAGES', status: 'UNSUPPORTED' }],
            expected: { skipped_includes: 'UPSCALE_LOW_RES_IMAGES', review_required: true, production_certified: false }
        },
        {
            name: "7. RECOMPRESS_IMAGES unsupported.",
            requested_fixes: ['RECOMPRESS_IMAGES'],
            findings: [{ id: 'EXCESSIVE_RESOLUTION' }],
            mockRepairs: [{ code: 'RECOMPRESS_IMAGES', status: 'UNSUPPORTED' }],
            expected: { skipped_includes: 'RECOMPRESS_IMAGES', review_required: true, production_certified: false } // requested fix on excessive resolution -> review
        },
        {
            name: "8. REPLACE_LOW_RES_IMAGES unsupported.",
            requested_fixes: ['REPLACE_LOW_RES_IMAGES'],
            findings: [{ id: 'LOW_RES_IMAGES' }],
            mockRepairs: [{ code: 'REPLACE_LOW_RES_IMAGES', status: 'UNSUPPORTED' }],
            expected: { skipped_includes: 'REPLACE_LOW_RES_IMAGES', review_required: true, production_certified: false }
        },
        {
            name: "9. Engine incorrectly reports unsupported image fix as APPLIED.",
            requested_fixes: ['NORMALIZE_IMAGE_COLORSPACE'],
            findings: [],
            mockRepairs: [{ code: 'NORMALIZE_IMAGE_COLORSPACE', status: 'APPLIED', implemented: false }],
            expected: { applied_includes_false: 'NORMALIZE_IMAGE_COLORSPACE', skipped_includes: 'NORMALIZE_IMAGE_COLORSPACE', moved_to_skipped: true }
        },
        {
            name: "10. Future applied visual image rewrite fix.",
            requested_fixes: ['UPSCALE_LOW_RES_IMAGES'],
            findings: [],
            mockRepairs: [{ code: 'UPSCALE_LOW_RES_IMAGES', status: 'APPLIED', visually_sensitive: true }],
            expected: { review_required: true, production_certified: false, certified_pdf_allowed: false }
        },
        {
            name: "11. Findings never applied.",
            requested_fixes: [],
            findings: [{ id: 'JPEG_ARTIFACTS' }, { id: 'LOW_RES_IMAGES' }],
            mockRepairs: [{ code: 'JPEG_ARTIFACTS', status: 'APPLIED' }, { code: 'LOW_RES_IMAGES', status: 'APPLIED' }],
            expected: { applied_includes_false: 'JPEG_ARTIFACTS', moved_to_review_reason: true }
        }
    ];

    const results = [];

    const engineAutofixOrig = createStandardEngine().autofixPdf;

    for (const scenario of scenarios) {
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
            let deltaReport = { image_quality_governance: {} };

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
            if (scenario.expected.warning_preserved && deltaReport.image_quality_governance.excessive_resolution_present !== true) {
                passed = false;
                errors.push(`Expected excessive_resolution_present=true in governance`);
            }
            if (scenario.expected.highest_risk && deltaReport.image_quality_governance.highest_image_quality_risk !== scenario.expected.highest_risk) {
                passed = false;
                errors.push(`Expected highest_image_quality_risk=${scenario.expected.highest_risk}, got ${deltaReport.image_quality_governance.highest_image_quality_risk}`);
            }
            if (scenario.expected.skipped_includes && !fixAudit.skipped_fixes.some(f => (f.code || f.fix_id) === scenario.expected.skipped_includes)) {
                passed = false;
                errors.push(`Expected skipped_fixes to include ${scenario.expected.skipped_includes}`);
            }
            if (scenario.expected.applied_includes_false && fixAudit.applied_fixes.some(f => (f.code || f.fix_id) === scenario.expected.applied_includes_false)) {
                passed = false;
                errors.push(`Expected applied_fixes NOT to include ${scenario.expected.applied_includes_false}`);
            }
            if (scenario.expected.moved_to_skipped && !fixAudit.skipped_fixes.some(f => f.moved_from_applied_to_skipped)) {
                passed = false;
                errors.push(`Expected moved_from_applied_to_skipped=true in skipped_fixes`);
            }
            if (scenario.expected.certified_pdf_allowed !== undefined && deltaReport.image_quality_governance.certified_pdf_allowed !== scenario.expected.certified_pdf_allowed) {
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
                image_quality_governance: deltaReport.image_quality_governance,
                review_required: fixAudit.review_required,
                production_certified: fixAudit.production_certified,
                artifact_policy: fixAudit.artifact_policy,
                certified_pdf_allowed: deltaReport.image_quality_governance.certified_pdf_allowed,
                pass: passed,
                errors: errors.length ? errors : undefined
            });
            
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
    reqCache.exports.createStandardEngine = createStandardEngine;

    const reportJson = {
        phase: "54B",
        name: "Worker Image Quality Artifact Policy",
        timestamp: new Date().toISOString(),
        scenarios: results,
        pass: results.every(r => r.pass)
    };

    await fs.writeJson(REPORT_JSON, reportJson, { spaces: 2 });

    let md = `# Phase 54B Worker Image Quality Artifact Policy Smoke Test\n\n`;
    md += `**Result:** ${reportJson.pass ? '✅ PASS' : '❌ FAIL'}\n\n`;

    for (const r of results) {
        md += `### ${r.scenario}\n`;
        md += `- **Pass:** ${r.pass ? '✅' : '❌'}\n`;
        if (r.errors) {
            md += `- **Errors:**\n${r.errors.map(e => `  - ${e}`).join('\n')}\n`;
        }
        md += `- **Review Required:** ${r.review_required}\n`;
        md += `- **Production Certified:** ${r.production_certified}\n`;
        md += `- **Governance:** \n\`\`\`json\n${JSON.stringify(r.image_quality_governance, null, 2)}\n\`\`\`\n\n`;
    }

    await fs.writeFile(REPORT_MD, md);

    console.log(`Smoke test completed. Pass: ${reportJson.pass}`);
    if (!reportJson.pass) process.exit(1);
}

runScenarios().catch(err => {
    console.error(err);
    process.exit(1);
});
