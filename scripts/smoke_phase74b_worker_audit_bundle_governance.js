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

    // Scenarios covering audit_bundle_governance derivation
    const scenarios = [
        // 1. Baseline successful run -> audit_bundle_governance present with hashes and domains
        {
            name: 'baseline run -> audit_bundle_governance present with hashes and governance domains',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: false,
                review_required: false,
                visual_diff_evidence: {}
            },
            checks: (gov) => {
                const notes = [];
                if (!gov.fix_audit_hash || typeof gov.fix_audit_hash !== 'string' || gov.fix_audit_hash.length !== 64) {
                    notes.push('fix_audit_hash should be a 64-char hex sha256 digest');
                }
                if (!gov.delta_report_hash || typeof gov.delta_report_hash !== 'string' || gov.delta_report_hash.length !== 64) {
                    notes.push('delta_report_hash should be a 64-char hex sha256 digest');
                }
                if (gov.fix_audit_hash === gov.delta_report_hash) {
                    notes.push('fix_audit_hash and delta_report_hash should differ');
                }
                if (!Array.isArray(gov.governance_domains) || gov.governance_domains.length === 0) {
                    notes.push('governance_domains should be a non-empty array');
                }
                if (!gov.governance_domains.includes('artifact_trust')) {
                    notes.push('governance_domains should include artifact_trust');
                }
                if (!gov.governance_domains.includes('machine_readiness_governance')) {
                    notes.push('governance_domains should include machine_readiness_governance');
                }
                if (!gov.artifact_trust) notes.push('artifact_trust missing from audit_bundle_governance');
                if (gov.bundle_complete !== true) notes.push('bundle_complete should be true');
                return notes;
            }
        },
        // 2. Review required -> audit_bundle_governance still present, carries warning
        {
            name: 'review required -> audit_bundle_governance present with review warning',
            jobExtraData: { findings: [{ id: 'RGB_IMAGES_PRESENT' }] },
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: false,
                review_required: true,
                visual_diff_evidence: {}
            },
            checks: (gov, audit) => {
                const notes = [];
                if (!audit.artifact_trust.review_required) notes.push('expected artifact_trust.review_required=true for this scenario');
                if (gov.evidence.review_required !== true) notes.push('audit_bundle_governance.evidence.review_required should be true');
                if (!gov.warnings.some(w => w.includes('review'))) notes.push('warnings should mention pending review');
                if (gov.production_certified !== false) notes.push('production_certified must be false (no overclaim)');
                if (gov.standard_certified !== false) notes.push('standard_certified must be false (no overclaim)');
                return notes;
            }
        },
        // 3. REGRESSION: audit_bundle_governance present in both fix_audit.json and delta_report.json,
        // both copies identical, and required fields present.
        {
            name: 'REGRESSION: audit_bundle_governance present identically in fix_audit.json and delta_report.json',
            jobExtraData: { findings: [{ id: 'STANDARD_VALIDATION_PASSED' }] },
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: false,
                review_required: false,
                visual_diff_evidence: {}
            },
            checks: (gov, audit, delta) => {
                const notes = [];
                if (!audit.audit_bundle_governance) notes.push('audit_bundle_governance missing from fix_audit.json');
                if (!delta.audit_bundle_governance) notes.push('audit_bundle_governance missing from delta_report.json');
                const requiredFields = ['fix_audit_hash', 'delta_report_hash', 'governance_domains', 'artifact_trust', 'bundle_complete', 'production_certified', 'standard_certified', 'warnings', 'evidence'];
                for (const field of requiredFields) {
                    if (!(field in gov)) notes.push(`audit_bundle_governance missing field: ${field}`);
                }
                if (JSON.stringify(audit.audit_bundle_governance) !== JSON.stringify(delta.audit_bundle_governance)) {
                    notes.push('audit_bundle_governance should be identical in fix_audit.json and delta_report.json');
                }
                // audit_bundle_governance itself must not be part of the hashed governance domain list
                // it summarizes (it is computed before being attached).
                if (gov.governance_domains.includes('audit_bundle_governance')) {
                    notes.push('governance_domains should not include audit_bundle_governance itself');
                }
                return notes;
            }
        }
    ];

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase74b-worker-test-${Date.now()}`);
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
                jobId: 'job-74b',
                tenantId: 'tenant-74b',
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

            const gov = audit.audit_bundle_governance;

            if (!gov) {
                pass = false;
                notes.push('audit_bundle_governance missing from fix_audit.json');
            } else {
                const checkNotes = scenario.checks(gov, audit, delta);
                checkNotes.forEach(n => { pass = false; notes.push(n); });
            }

            results.push({
                scenario: scenario.name,
                status: result.status,
                audit_bundle_governance: gov || {},
                fix_audit_hash: gov ? gov.fix_audit_hash : null,
                delta_report_hash: gov ? gov.delta_report_hash : null,
                governance_domains: gov ? gov.governance_domains : [],
                bundle_complete: gov ? gov.bundle_complete : null,
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

    const reportJsonPath = path.join(REPORTS_DIR, 'phase74b_worker_audit_bundle_governance.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase74b_worker_audit_bundle_governance.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '74B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        results
    }, { spaces: 2 });

    let md = `# Phase 74B — Worker Audit Bundle Governance\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n\n`;
    md += `Validates that \`audit_bundle_governance\` is emitted in both \`fix_audit.json\` and \`delta_report.json\`. Enforces:\n\n`;
    md += `- \`fix_audit_hash\` and \`delta_report_hash\` are stable SHA-256 digests of the respective report contents (computed prior to attaching \`audit_bundle_governance\` itself).\n`;
    md += `- \`governance_domains\` enumerates every \`*_governance\` section plus \`artifact_trust\` present in the bundle.\n`;
    md += `- \`artifact_trust\` is preserved verbatim for downstream audit consumers.\n`;
    md += `- \`production_certified\` and \`standard_certified\` are always \`false\` — the bundle is a packaging/evidence index, never a certification authority.\n`;
    md += `- \`audit_bundle_governance\` is identical across \`fix_audit.json\` and \`delta_report.json\`.\n\n`;
    md += `## Results\n\n`;

    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass ? '✅' : '❌'}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Status:** ${res.status}\n`;
        md += `- **fix_audit_hash:** ${res.fix_audit_hash}\n`;
        md += `- **delta_report_hash:** ${res.delta_report_hash}\n`;
        md += `- **governance_domains:** ${(res.governance_domains || []).join(', ') || 'none'}\n`;
        md += `- **bundle_complete:** ${res.bundle_complete}\n\n`;
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
