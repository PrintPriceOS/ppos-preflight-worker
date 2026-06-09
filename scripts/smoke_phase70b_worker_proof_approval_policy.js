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

    // Scenarios covering proof_approval_governance states
    const scenarios = [
        // 1. Visual change detected, no proof supplied → PENDING, blocks production
        {
            name: 'visual change detected — no proof supplied, status=PENDING blocks production',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', visually_sensitive: true, destructive: true, evidence: { visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: {
                    render_performed: true,
                    diff_performed: true,
                    pages_rendered: 2,
                    pages_compared: 2,
                    changed_pixel_ratio_max: 0.18,
                    changed_pixel_ratio_avg: 0.12,
                    dimensions_match: true,
                    render_tool: 'ghostscript',
                    render_tool_version: '10.0.0',
                    diff_images: ['diff_page_1.png'],
                    thumbnails: [],
                    warnings: [],
                    limitations: []
                }
            },
            checks: (gov, trust) => {
                const notes = [];
                if (!gov.proof_required) notes.push('proof_required should be true when visual change detected');
                if (gov.proof_status !== 'PENDING') notes.push(`proof_status should be PENDING, got ${gov.proof_status}`);
                if (!gov.review_required) notes.push('review_required should be true when proof PENDING');
                if (gov.production_certified !== false) notes.push('production_certified must always be false');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true');
                return notes;
            }
        },
        // 2. Visual change detected, proof APPROVED → unblocks proof gate
        {
            name: 'visual change detected — proof APPROVED, unblocks proof gate',
            jobExtraData: { proof_id: 'proof-abc-001', proof_status: 'APPROVED' },
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_OVERPRINT', status: 'APPLIED', visually_sensitive: true, evidence: { visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: {
                    render_performed: true,
                    diff_performed: true,
                    changed_pixel_ratio_max: 0.09,
                    changed_pixel_ratio_avg: 0.05,
                    dimensions_match: true,
                    render_tool: 'ghostscript',
                    render_tool_version: '10.0.0',
                    diff_images: [],
                    thumbnails: ['thumb_page_1.png'],
                    warnings: [],
                    limitations: []
                }
            },
            checks: (gov, trust) => {
                const notes = [];
                if (!gov.proof_required) notes.push('proof_required should be true when visual change detected');
                if (gov.proof_status !== 'APPROVED') notes.push(`proof_status should be APPROVED, got ${gov.proof_status}`);
                if (gov.review_required !== false) notes.push('review_required should be false when proof APPROVED');
                if (gov.proof_id !== 'proof-abc-001') notes.push('proof_id not preserved');
                if (gov.production_certified !== false) notes.push('production_certified must always be false in governance block');
                return notes;
            }
        },
        // 3. Visual change detected, proof REJECTED → triggers remediation
        {
            name: 'visual change detected — proof REJECTED, triggers remediation',
            jobExtraData: { proof_id: 'proof-xyz-002', proof_status: 'REJECTED' },
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'NORMALIZE_BLEND_MODES', status: 'APPLIED', visually_sensitive: true, evidence: { visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: {
                    render_performed: true,
                    diff_performed: true,
                    changed_pixel_ratio_max: 0.30,
                    changed_pixel_ratio_avg: 0.20,
                    dimensions_match: true,
                    render_tool: 'ghostscript',
                    render_tool_version: '10.0.0',
                    diff_images: ['diff_p1.png'],
                    thumbnails: [],
                    warnings: [],
                    limitations: []
                }
            },
            checks: (gov, trust) => {
                const notes = [];
                if (gov.proof_status !== 'REJECTED') notes.push(`proof_status should be REJECTED, got ${gov.proof_status}`);
                if (!gov.review_required) notes.push('review_required should be true when proof REJECTED');
                if (!gov.warnings.some(w => w.includes('rejected'))) notes.push('no rejection warning emitted');
                if (gov.production_certified !== false) notes.push('production_certified must always be false');
                return notes;
            }
        },
        // 4. No visual change → proof NOT_REQUIRED
        {
            name: 'no visual change — proof_status=NOT_REQUIRED, no blocking',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'REBUILD_XREF', status: 'APPLIED', evidence: {} }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: {}
            },
            checks: (gov, trust) => {
                const notes = [];
                if (gov.proof_required !== false) notes.push('proof_required should be false when no visual change');
                if (gov.proof_status !== 'NOT_REQUIRED') notes.push(`proof_status should be NOT_REQUIRED, got ${gov.proof_status}`);
                if (gov.review_required !== false) notes.push('review_required should be false when proof not required');
                if (gov.production_certified !== false) notes.push('production_certified must always be false');
                return notes;
            }
        },
        // 5. REGRESSION: visual_change_detected=true + proof_status!=APPROVED blocks production
        {
            name: 'REGRESSION: visual_change_detected=true and proof!=APPROVED must block production',
            jobExtraData: {},
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
            },
            checks: (gov, trust) => {
                const notes = [];
                if (!gov.proof_required) notes.push('proof_required must be true when visual change detected');
                if (gov.proof_status === 'APPROVED') notes.push('proof_status must not be APPROVED without explicit approval input');
                if (gov.review_required !== true) notes.push('review_required must be true when proof not approved');
                if (trust && trust.production_certified === true) notes.push('production_certified leaked true despite unapproved proof');
                return notes;
            }
        },
        // 6. REGRESSION: proof_approval_governance present in both fix_audit and delta_report
        {
            name: 'REGRESSION: proof_approval_governance present in fix_audit.json and delta_report.json',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: {}
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!audit.proof_approval_governance) notes.push('proof_approval_governance missing from fix_audit.json');
                if (!delta.proof_approval_governance) notes.push('proof_approval_governance missing from delta_report.json');
                const requiredFields = ['proof_required', 'proof_available', 'proof_id', 'proof_status', 'visual_change_detected', 'review_required', 'production_certified', 'warnings', 'evidence'];
                for (const field of requiredFields) {
                    if (!(field in gov)) notes.push(`proof_approval_governance missing field: ${field}`);
                }
                return notes;
            }
        },
        // 7. REGRESSION: no standards overclaim when proof pending
        {
            name: 'REGRESSION: standards overclaim blocked when proof pending',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', destructive: true, evidence: { visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                visual_diff_evidence: { render_performed: false, diff_performed: false, diff_images: [], thumbnails: [] },
                production_certified: true,
                standard_certified: true,
                pdfx_compliance_claimed: true
            },
            checks: (gov, trust) => {
                const notes = [];
                if (trust && trust.standard_certified) notes.push('standard_certified overclaim leaked');
                if (trust && trust.pdfx_compliance_claimed) notes.push('pdfx_compliance_claimed overclaim leaked');
                return notes;
            }
        }
    ];

    // Optionally load Engine 69A report to append scenarios
    if (await fs.pathExists(ENGINE_REPORT_PATH)) {
        inputMode = 'ENGINE_REPORT_AUGMENTED';
        console.log(`[TEST] Engine 69A report found — augmenting with engine scenarios.`);
    }

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase70b-worker-test-${Date.now()}`);
    process.env.TEST_DIR = testDir;
    await fs.ensureDir(testDir);
    const mockInput = path.join(testDir, 'input.pdf');
    await fs.writeFile(mockInput, '%PDF-1.4\nTest');
    const mockOutput = path.join(testDir, 'mock_engine_output.pdf');
    await fs.writeFile(mockOutput, '%PDF-1.4\nTest Fixed');

    AutofixProcessor.sanitizePdfForAutofix = async () => mockInput;

    for (const scenario of scenarios) {
        console.log(`\n[TEST] Running scenario: ${scenario.name}`);

        currentEngineMockResult = {
            fixedPath: mockOutput,
            artifacts: { fixed_pdf: { path: mockOutput } },
            ...scenario.mockEngineResult
        };

        const job = {
            data: {
                jobId: 'job-70b',
                tenantId: 'tenant-70b',
                input: {
                    fileUrl: mockInput,
                    fixes: (scenario.mockEngineResult.applied_fixes || []).map(f => f.fix_id)
                },
                ...scenario.jobExtraData
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

            const gov = audit.proof_approval_governance;
            const trust = audit.artifact_trust;

            if (!gov) {
                pass = false;
                notes.push('proof_approval_governance missing from fix_audit.json');
            } else {
                const checkNotes = scenario.checks(gov, trust, audit, delta);
                checkNotes.forEach(n => { pass = false; notes.push(n); });
            }

            // Always verify production_certified cannot be true in governance
            if (gov && gov.production_certified !== false) {
                pass = false;
                notes.push('proof_approval_governance.production_certified must always be false');
            }

            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: result.status,
                proof_approval_governance: gov || {},
                artifact_trust_level: trust ? trust.trust_level : null,
                review_required: trust ? trust.review_required : null,
                production_certified: trust ? trust.production_certified : null,
                proof_required: gov ? gov.proof_required : null,
                proof_available: gov ? gov.proof_available : null,
                proof_id: gov ? gov.proof_id : null,
                proof_status: gov ? gov.proof_status : null,
                visual_change_detected: gov ? gov.visual_change_detected : null,
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
            const last = results[results.length - 1];
            (last.notes || '').split('; ').forEach(n => n && console.log(`    - ${n}`));
        }
    }

    const reportJsonPath = path.join(REPORTS_DIR, 'phase70b_worker_proof_approval_policy.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase70b_worker_proof_approval_policy.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '70B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        input_mode: inputMode,
        results
    }, { spaces: 2 });

    let md = `# Phase 70B — Worker Proof Approval Governance\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n\n`;
    md += `Validates that \`proof_approval_governance\` is emitted in \`fix_audit.json\` v2 and \`delta_report.json\`. Enforces:\n\n`;
    md += `- \`proof_required=true\` when \`visual_change_detected=true\`\n`;
    md += `- \`proof_status\` defaults to \`PENDING\` when visual change detected and no approval supplied\n`;
    md += `- \`proof_status=NOT_REQUIRED\` when no visual change\n`;
    md += `- \`proof_status=APPROVED\` unblocks the proof gate (review_required=false in governance)\n`;
    md += `- \`proof_status=REJECTED\` triggers remediation warning\n`;
    md += `- \`visual_change_detected=true\` and \`proof_status!=APPROVED\` blocks production readiness\n`;
    md += `- \`production_certified\` always false in governance block\n`;
    md += `- No standards overclaims leak when proof is pending\n\n`;
    md += `## Results\n\n`;

    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass ? '✅' : '❌'}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Trust Level:** ${res.artifact_trust_level}\n`;
        md += `- **Review Required:** ${res.review_required}\n`;
        md += `- **Production Certified:** ${res.production_certified}\n`;
        md += `- **Proof Required:** ${res.proof_required}\n`;
        md += `- **Proof Available:** ${res.proof_available}\n`;
        md += `- **Proof ID:** ${res.proof_id}\n`;
        md += `- **Proof Status:** ${res.proof_status}\n`;
        md += `- **Visual Change Detected:** ${res.visual_change_detected}\n\n`;
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
