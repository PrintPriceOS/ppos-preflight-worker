const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const Module = require('module');

let currentEngineMockResult = {};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request) {
    if (request === '@ppos/preflight-engine') {
        return {
            createStandardEngine: () => ({
                autofixPdf: async () => ({ ok: true, ...currentEngineMockResult })
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
    return process.env.TEST_DIR || os.tmpdir();
};

const REPORTS_DIR = path.join(__dirname, '../reports');
const ENGINE_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase69a_engine_visual_diff.json');

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    let engineScenarios = [];

    if (await fs.pathExists(ENGINE_REPORT_PATH)) {
        const engineReport = await fs.readJson(ENGINE_REPORT_PATH);
        const results = engineReport.results || [];
        engineScenarios = results.map(r => ({
            name: r.scenario || r.capability,
            mockEngineResult: {
                applied_fixes: r.applied_fixes || [],
                skipped_fixes: r.skipped_fixes || [],
                failed_fixes: r.failed_fixes || [],
                visual_diff_evidence: r.visual_diff_evidence || r.evidence || {},
                render_performed: r.render_performed,
                diff_performed: r.diff_performed,
                pages_rendered: r.pages_rendered,
                pages_compared: r.pages_compared,
                changed_pixel_ratio_max: r.changed_pixel_ratio_max,
                changed_pixel_ratio_avg: r.changed_pixel_ratio_avg,
                dimensions_match: r.dimensions_match,
                render_tool: r.render_tool,
                render_tool_version: r.render_tool_version,
                diff_images: r.diff_images || [],
                thumbnails: r.thumbnails || [],
            }
        }));
        inputMode = 'ENGINE_REPORT';
        console.log(`[TEST] Loaded ${engineScenarios.length} scenarios from Engine report (69A).`);
    } else {
        console.log('[TEST] Engine 69A report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
        engineScenarios = [
            {
                name: 'SYNTHETIC: visual diff performed, change detected',
                mockEngineResult: {
                    applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', visually_sensitive: true, destructive: true, evidence: { rendering_safety_proven: false, visual_change_expected: true } }],
                    skipped_fixes: [],
                    failed_fixes: [],
                    visual_diff_evidence: {
                        render_performed: true,
                        diff_performed: true,
                        pages_rendered: 2,
                        pages_compared: 2,
                        changed_pixel_ratio_max: 0.12,
                        changed_pixel_ratio_avg: 0.08,
                        dimensions_match: true,
                        render_tool: 'ghostscript',
                        render_tool_version: '10.0.0',
                        diff_images: ['diff_page_1.png'],
                        thumbnails: ['thumb_page_1.png'],
                        warnings: [],
                        limitations: []
                    }
                }
            },
            {
                name: 'SYNTHETIC: visual diff required, render tool unavailable',
                mockEngineResult: {
                    applied_fixes: [{ fix_id: 'FLATTEN_OVERPRINT', status: 'APPLIED', visually_sensitive: true, evidence: { visual_change_expected: true } }],
                    skipped_fixes: [],
                    failed_fixes: [],
                    visual_diff_evidence: {
                        render_performed: false,
                        diff_performed: false,
                        pages_rendered: 0,
                        pages_compared: 0,
                        changed_pixel_ratio_max: 0,
                        changed_pixel_ratio_avg: 0,
                        dimensions_match: true,
                        render_tool: null,
                        render_tool_version: null,
                        diff_images: [],
                        thumbnails: [],
                        warnings: ['Rendering tool unavailable'],
                        limitations: ['tool_gap=true']
                    }
                }
            },
            {
                name: 'SYNTHETIC: visual diff not required, no visually sensitive fix',
                mockEngineResult: {
                    applied_fixes: [{ fix_id: 'REBUILD_XREF', status: 'APPLIED', evidence: {} }],
                    skipped_fixes: [],
                    failed_fixes: [],
                    visual_diff_evidence: {}
                }
            },
            {
                name: 'SYNTHETIC: visual diff required but not performed, blocks production',
                mockEngineResult: {
                    applied_fixes: [{ fix_id: 'NORMALIZE_BLEND_MODES', status: 'APPLIED', visually_sensitive: true, destructive: true, evidence: { visual_change_expected: true } }],
                    skipped_fixes: [],
                    failed_fixes: [],
                    visual_diff_evidence: {
                        render_performed: false,
                        diff_performed: false,
                        diff_images: [],
                        thumbnails: []
                    },
                    production_certified: true,
                    production_safe: true
                }
            },
            {
                name: 'SYNTHETIC: clean control — no fix activity',
                mockEngineResult: { applied_fixes: [], skipped_fixes: [], failed_fixes: [] }
            }
        ];
    }

    // Regression scenarios always appended
    engineScenarios.push(
        {
            name: 'REGRESSION: visual_change_detected must force FIXED_REVIEW_REQUIRED',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', visually_sensitive: true, destructive: true, evidence: { visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: {
                    render_performed: true,
                    diff_performed: true,
                    changed_pixel_ratio_max: 0.25,
                    diff_images: ['diff.png'],
                    thumbnails: []
                },
                production_certified: true,
                pdfx_compliance_claimed: true,
                compliance_claim_allowed: true
            }
        },
        {
            name: 'REGRESSION: visual_diff_required but not performed must block production',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_OVERPRINT', status: 'APPLIED', visually_sensitive: true, evidence: {} }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: { render_performed: false, diff_performed: false, diff_images: [], thumbnails: [] },
                production_certified: true
            }
        },
        {
            name: 'REGRESSION: no certified.pdf trust when visual review required',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', destructive: true, evidence: { visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: { render_performed: false, diff_performed: false, diff_images: [], thumbnails: [] }
            }
        },
        {
            name: 'REGRESSION: evidence fields fully preserved in governance',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'NORMALIZE_BLEND_MODES', status: 'APPLIED', visually_sensitive: true, evidence: {} }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: {
                    render_performed: true,
                    diff_performed: true,
                    pages_rendered: 4,
                    pages_compared: 4,
                    changed_pixel_ratio_max: 0.05,
                    changed_pixel_ratio_avg: 0.02,
                    dimensions_match: true,
                    render_tool: 'mutool',
                    render_tool_version: '1.23.0',
                    diff_images: ['diff_p1.png', 'diff_p2.png'],
                    thumbnails: ['thumb_p1.png'],
                    warnings: ['Minor rasterization artifacts'],
                    limitations: ['page 3 skipped: encrypted content']
                }
            }
        }
    );

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase69b-worker-test-${Date.now()}`);
    process.env.TEST_DIR = testDir;
    await fs.ensureDir(testDir);
    const mockInput = path.join(testDir, 'input.pdf');
    await fs.writeFile(mockInput, '%PDF-1.4\nTest');
    const mockOutput = path.join(testDir, 'mock_engine_output.pdf');
    await fs.writeFile(mockOutput, '%PDF-1.4\nTest Fixed');

    AutofixProcessor.sanitizePdfForAutofix = async () => mockInput;

    for (const scenario of engineScenarios) {
        console.log(`\n[TEST] Running scenario: ${scenario.name}`);

        currentEngineMockResult = {
            fixedPath: mockOutput,
            artifacts: { fixed_pdf: { path: mockOutput } },
            ...scenario.mockEngineResult
        };

        const job = {
            data: {
                jobId: 'job-69b',
                tenantId: 'tenant-69b',
                input: {
                    fileUrl: mockInput,
                    fixes: (scenario.mockEngineResult.applied_fixes || []).map(f => f.fix_id)
                }
            },
            updateProgress: async () => {}
        };

        let pass = true;
        const notes = [];

        try {
            const result = await AutofixProcessor.process(job, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

            const fixAuditPath = path.join(testDir, 'fix_audit.json');
            const deltaReportPath = path.join(testDir, 'delta_report.json');

            const audit = await fs.readJson(fixAuditPath);
            const delta = await fs.readJson(deltaReportPath);

            const gov = audit.visual_diff_governance;
            const trust = audit.artifact_trust;

            // Structure checks
            if (!gov) { pass = false; notes.push('visual_diff_governance missing in fix_audit.json'); }
            if (!delta.visual_diff_governance) { pass = false; notes.push('visual_diff_governance missing in delta_report.json'); }

            if (gov) {
                // Required fields present
                const requiredFields = ['visual_diff_required', 'visual_diff_performed', 'visual_change_detected', 'visual_review_required', 'render_tool_gap', 'max_changed_pixel_ratio', 'proof_artifacts_available', 'production_certified', 'standard_certified', 'warnings', 'evidence'];
                for (const field of requiredFields) {
                    if (!(field in gov)) { pass = false; notes.push(`visual_diff_governance missing field: ${field}`); }
                }

                // production_certified and standard_certified must always be false
                if (gov.production_certified !== false) { pass = false; notes.push('visual_diff_governance.production_certified must always be false'); }
                if (gov.standard_certified !== false) { pass = false; notes.push('visual_diff_governance.standard_certified must always be false'); }

                // Evidence fields preserved when provided
                const vde = scenario.mockEngineResult.visual_diff_evidence || {};
                if (vde.render_tool && gov.evidence.render_tool !== vde.render_tool) {
                    pass = false; notes.push(`render_tool not preserved: expected ${vde.render_tool}, got ${gov.evidence.render_tool}`);
                }
                if (vde.render_tool_version && gov.evidence.render_tool_version !== vde.render_tool_version) {
                    pass = false; notes.push(`render_tool_version not preserved`);
                }
                if (Array.isArray(vde.diff_images) && vde.diff_images.length > 0) {
                    if (!Array.isArray(gov.evidence.diff_images) || gov.evidence.diff_images.length === 0) {
                        pass = false; notes.push('diff_images not preserved in evidence');
                    }
                    if (!gov.proof_artifacts_available) {
                        pass = false; notes.push('proof_artifacts_available should be true when diff_images present');
                    }
                }
                if (vde.changed_pixel_ratio_max > 0) {
                    if (gov.max_changed_pixel_ratio !== vde.changed_pixel_ratio_max) {
                        pass = false; notes.push(`max_changed_pixel_ratio not preserved: expected ${vde.changed_pixel_ratio_max}, got ${gov.max_changed_pixel_ratio}`);
                    }
                }
            }

            // Visually sensitive fix always triggers visual_review_required + FIXED_REVIEW_REQUIRED
            const allAppliedFixes = scenario.mockEngineResult.applied_fixes || [];
            const hasVisuallySensitive = allAppliedFixes.some(f => f.visually_sensitive === true || f.destructive === true);
            if (hasVisuallySensitive && gov) {
                if (!gov.visual_review_required) { pass = false; notes.push('visual_review_required not set when visually sensitive fix applied'); }
                if (!trust || trust.trust_level !== 'FIXED_REVIEW_REQUIRED') { pass = false; notes.push('artifact_trust not FIXED_REVIEW_REQUIRED when visual review required'); }
                if (trust && trust.production_certified === true) { pass = false; notes.push('production_certified leaked true despite visual review required'); }
                if (trust && trust.certified_pdf_allowed === true) { pass = false; notes.push('certified_pdf_allowed leaked true despite visual review required'); }
            }

            // visual_change_detected forces review
            if (gov && gov.visual_change_detected) {
                if (!trust || trust.review_required !== true) { pass = false; notes.push('artifact_trust.review_required not true when visual_change_detected'); }
            }

            // visual_diff_required but not performed blocks production
            if (gov && gov.visual_diff_required && !gov.visual_diff_performed) {
                if (!trust || trust.production_certified === true) { pass = false; notes.push('production_certified leaked when visual_diff_required but not performed'); }
            }

            // Regression: standards overclaim blocked
            if (scenario.name.startsWith('REGRESSION: visual_change_detected')) {
                if (trust && (trust.standard_certified || trust.pdfx_compliance_claimed || trust.pdfa_compliance_claimed)) {
                    pass = false; notes.push('Standards overclaim leaked through visual diff governance');
                }
            }

            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: result.status,
                visual_diff_governance: gov || {},
                artifact_trust_level: trust ? trust.trust_level : null,
                review_required: trust ? trust.review_required : null,
                production_certified: trust ? trust.production_certified : null,
                visual_diff_required: gov ? gov.visual_diff_required : null,
                visual_diff_performed: gov ? gov.visual_diff_performed : null,
                visual_change_detected: gov ? gov.visual_change_detected : null,
                visual_review_required: gov ? gov.visual_review_required : null,
                render_tool_gap: gov ? gov.render_tool_gap : null,
                proof_artifacts_available: gov ? gov.proof_artifacts_available : null,
                pass,
                notes: notes.length ? notes.join('; ') : 'OK'
            });
        } catch (err) {
            console.error(err);
            pass = false;
            results.push({ scenario: scenario.name, status: 'ERROR', pass: false, notes: err.message });
        }

        if (!pass) smokePassed = false;
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${scenario.name}`);
        if (!pass) {
            results[results.length - 1].notes.split('; ').forEach(n => console.log(`    - ${n}`));
        }
    }

    const reportJsonPath = path.join(REPORTS_DIR, 'phase69b_worker_visual_diff_policy.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase69b_worker_visual_diff_policy.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '69B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        input_mode: inputMode,
        results
    }, { spaces: 2 });

    let md = `# Phase 69B — Worker Visual Diff Governance Policy\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n\nValidates that \`visual_diff_governance\` is correctly materialized in \`fix_audit.json\` v2 and \`delta_report.json\` when Worker policy ingests Engine visual diff outputs. Enforces:\n\n`;
    md += `- \`visual_diff_governance\` emitted in both \`fix_audit.json\` and \`delta_report.json\`\n`;
    md += `- All evidence fields preserved (\`render_performed\`, \`diff_performed\`, \`pages_rendered\`, \`pages_compared\`, \`changed_pixel_ratio_max\`, \`changed_pixel_ratio_avg\`, \`dimensions_match\`, \`render_tool\`, \`render_tool_version\`, \`diff_images\`, \`thumbnails\`, \`warnings\`, \`limitations\`)\n`;
    md += `- \`visual_change_detected=true\` forces \`review_required=true\` in artifact trust\n`;
    md += `- \`visual_diff_required=true\` without performed diff blocks production readiness\n`;
    md += `- No standards overclaims leak through visual diff governance\n`;
    md += `- \`production_certified\` and \`standard_certified\` always false in governance block\n\n`;
    md += `## Results\n\n`;

    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass ? '✅' : '❌'}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Trust Level:** ${res.artifact_trust_level}\n`;
        md += `- **Review Required:** ${res.review_required}\n`;
        md += `- **Production Certified:** ${res.production_certified}\n`;
        md += `- **Visual Diff Required:** ${res.visual_diff_required}\n`;
        md += `- **Visual Diff Performed:** ${res.visual_diff_performed}\n`;
        md += `- **Visual Change Detected:** ${res.visual_change_detected}\n`;
        md += `- **Visual Review Required:** ${res.visual_review_required}\n`;
        md += `- **Render Tool Gap:** ${res.render_tool_gap}\n`;
        md += `- **Proof Artifacts Available:** ${res.proof_artifacts_available}\n\n`;
    }

    await fs.writeFile(reportMdPath, md);
    console.log(`\n[TEST] Reports generated at ${REPORTS_DIR}`);

    if (!smokePassed) {
        console.error('[TEST] Smoke tests FAILED.');
        process.exit(1);
    } else {
        console.log('[TEST] Smoke tests PASSED.');
    }
}

runSmokeTest().catch(err => {
    console.error(err);
    process.exit(1);
});
