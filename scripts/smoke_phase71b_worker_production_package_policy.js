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

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    // Scenarios covering production_package_governance states
    const scenarios = [
        // 1. Clean production-certified artifact, no payment status supplied -> package ready
        {
            name: 'production certified, no review/proof/payment blockers -> package_ready=true',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'REBUILD_TRIMBOX', status: 'APPLIED', evidence: {} }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true,
                review_required: false,
                visual_diff_evidence: {}
            },
            checks: (gov, trust) => {
                const notes = [];
                if (gov.package_ready !== true) notes.push(`package_ready should be true, got ${gov.package_ready}`);
                if (gov.approved_artifact_type !== trust.primary_artifact_type) notes.push('approved_artifact_type should match artifact_trust.primary_artifact_type');
                if (!gov.approved_artifact_hash) notes.push('approved_artifact_hash should be set when package_ready=true');
                if (gov.blocked_by_governance_domains.length !== 0) notes.push('blocked_by_governance_domains should be empty');
                if (!gov.included_reports.includes('fix_audit.json')) notes.push('included_reports missing fix_audit.json');
                if (!gov.included_reports.includes('delta_report.json')) notes.push('included_reports missing delta_report.json');
                return notes;
            }
        },
        // 2. Review required (color governance risk) -> package not ready
        {
            name: 'review required (unsupported color fix) -> package_ready=false',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'CONVERT_RGB_TO_CMYK', code: 'CONVERT_RGB_TO_CMYK', reason: 'unsupported' }],
                failed_fixes: [],
                requested_fixes: ['CONVERT_RGB_TO_CMYK'],
                production_certified: false,
                review_required: true,
                visual_diff_evidence: {}
            },
            checks: (gov, trust) => {
                const notes = [];
                if (gov.package_ready !== false) notes.push('package_ready should be false when review_required=true');
                if (gov.approved_artifact_type !== null) notes.push('approved_artifact_type should be null when not ready');
                if (gov.approved_artifact_hash !== null) notes.push('approved_artifact_hash should be null when not ready');
                if (gov.blocked_by_governance_domains.length === 0) notes.push('blocked_by_governance_domains should be non-empty');
                if (gov.warnings.length === 0) notes.push('warnings should explain why package is not ready');
                return notes;
            }
        },
        // 3. Visual change detected, proof pending -> blocks production package
        {
            name: 'visual change detected, proof pending -> package_ready=false',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', visually_sensitive: true, destructive: true, evidence: { visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true,
                visual_diff_evidence: {
                    render_performed: true,
                    diff_performed: true,
                    changed_pixel_ratio_max: 0.2,
                    changed_pixel_ratio_avg: 0.15,
                    dimensions_match: true,
                    render_tool: 'ghostscript',
                    render_tool_version: '10.0.0',
                    diff_images: ['diff.png'],
                    thumbnails: []
                }
            },
            checks: (gov, trust) => {
                const notes = [];
                if (gov.package_ready !== false) notes.push('package_ready should be false when proof is pending');
                if (!gov.blocked_by_governance_domains.includes('proof_approval_governance')) notes.push('blocked_by_governance_domains should include proof_approval_governance');
                return notes;
            }
        },
        // 4. Production certified but payment unresolved -> package not ready
        {
            name: 'production certified, payment_status=UNPAID -> package_ready=false',
            jobExtraData: { payment_status: 'UNPAID' },
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'REBUILD_TRIMBOX', status: 'APPLIED', evidence: {} }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true,
                review_required: false,
                visual_diff_evidence: {}
            },
            checks: (gov, trust) => {
                const notes = [];
                if (gov.package_ready !== false) notes.push('package_ready should be false when payment is unresolved');
                if (!gov.blocked_by_governance_domains.includes('payment_governance')) notes.push('blocked_by_governance_domains should include payment_governance');
                if (!gov.warnings.some(w => w.includes('Payment status'))) notes.push('no payment warning emitted');
                return notes;
            }
        },
        // 5. Production certified and payment cleared -> package ready
        {
            name: 'production certified, payment_status=PAID -> package_ready=true',
            jobExtraData: { payment_status: 'PAID' },
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'REBUILD_TRIMBOX', status: 'APPLIED', evidence: {} }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true,
                review_required: false,
                visual_diff_evidence: {}
            },
            checks: (gov, trust) => {
                const notes = [];
                if (gov.package_ready !== true) notes.push('package_ready should be true when payment_status=PAID and no other blockers');
                if (gov.evidence.payment_status !== 'PAID') notes.push('evidence.payment_status not preserved');
                if (gov.evidence.payment_gate_satisfied !== true) notes.push('evidence.payment_gate_satisfied should be true');
                return notes;
            }
        },
        // 6. REGRESSION: production_package_governance present in fix_audit.json and delta_report.json with required fields
        {
            name: 'REGRESSION: production_package_governance present in fix_audit.json and delta_report.json',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: false,
                visual_diff_evidence: {}
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!audit.production_package_governance) notes.push('production_package_governance missing from fix_audit.json');
                if (!delta.production_package_governance) notes.push('production_package_governance missing from delta_report.json');
                const requiredFields = ['package_ready', 'approved_artifact_type', 'approved_artifact_hash', 'included_reports', 'blocked_by_governance_domains', 'warnings', 'evidence'];
                for (const field of requiredFields) {
                    if (!(field in gov)) notes.push(`production_package_governance missing field: ${field}`);
                }
                return notes;
            }
        },
        // 7. REGRESSION: package_ready never true when artifact_trust.production_certified is false
        {
            name: 'REGRESSION: production_certified=false must force package_ready=false',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'REBUILD_XREF', status: 'APPLIED', evidence: {} }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: false,
                review_required: false,
                visual_diff_evidence: {}
            },
            checks: (gov, trust) => {
                const notes = [];
                if (trust.production_certified !== false) notes.push('test setup invalid: expected production_certified=false');
                if (gov.package_ready !== false) notes.push('package_ready must be false when artifact_trust.production_certified=false');
                return notes;
            }
        }
    ];

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase71b-worker-test-${Date.now()}`);
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
                jobId: 'job-71b',
                tenantId: 'tenant-71b',
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

            const gov = audit.production_package_governance;
            const trust = audit.artifact_trust;

            if (!gov) {
                pass = false;
                notes.push('production_package_governance missing from fix_audit.json');
            } else {
                const checkNotes = scenario.checks(gov, trust, audit, delta);
                checkNotes.forEach(n => { pass = false; notes.push(n); });
            }

            results.push({
                scenario: scenario.name,
                status: result.status,
                production_package_governance: gov || {},
                artifact_trust_level: trust ? trust.trust_level : null,
                production_certified: trust ? trust.production_certified : null,
                package_ready: gov ? gov.package_ready : null,
                approved_artifact_type: gov ? gov.approved_artifact_type : null,
                approved_artifact_hash: gov ? gov.approved_artifact_hash : null,
                included_reports: gov ? gov.included_reports : [],
                blocked_by_governance_domains: gov ? gov.blocked_by_governance_domains : [],
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

    const reportJsonPath = path.join(REPORTS_DIR, 'phase71b_worker_production_package_policy.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase71b_worker_production_package_policy.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '71B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        results
    }, { spaces: 2 });

    let md = `# Phase 71B — Worker Production Package Governance\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n\n`;
    md += `Validates that \`production_package_governance\` is emitted in \`fix_audit.json\` v2 and \`delta_report.json\`, derived from \`artifact_trust\` and upstream review/proof/payment gates. Enforces:\n\n`;
    md += `- \`package_ready=true\` only when artifact is physically ready, production certified, review is not required, and no governance domains are blocking.\n`;
    md += `- \`package_ready=false\` when review is required, proof approval is pending/rejected, or payment is unresolved.\n`;
    md += `- \`approved_artifact_type\`/\`approved_artifact_hash\` set only when \`package_ready=true\`.\n`;
    md += `- \`included_reports\` always lists \`fix_audit.json\` and \`delta_report.json\`, plus any produced PDF artifacts.\n`;
    md += `- \`blocked_by_governance_domains\` mirrors \`artifact_trust.blocked_by_governance_domains\` plus \`payment_governance\` when payment is unresolved.\n\n`;
    md += `## Results\n\n`;

    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass ? '✅' : '❌'}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Trust Level:** ${res.artifact_trust_level}\n`;
        md += `- **Production Certified:** ${res.production_certified}\n`;
        md += `- **Package Ready:** ${res.package_ready}\n`;
        md += `- **Approved Artifact Type:** ${res.approved_artifact_type}\n`;
        md += `- **Approved Artifact Hash:** ${res.approved_artifact_hash}\n`;
        md += `- **Included Reports:** ${(res.included_reports || []).join(', ')}\n`;
        md += `- **Blocked Domains:** ${(res.blocked_by_governance_domains || []).join(', ') || 'none'}\n\n`;
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
