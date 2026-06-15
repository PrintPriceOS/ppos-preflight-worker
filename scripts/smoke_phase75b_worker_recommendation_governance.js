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

    // Scenarios covering recommendation_governance derivation
    const scenarios = [
        // 1. No findings -> empty action lists, governance invariants intact
        {
            name: 'no findings -> empty recommendation action lists',
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
                if (gov.recommendation_signals_available !== true) notes.push('recommendation_signals_available should be true');
                if (gov.total_findings !== 0) notes.push('total_findings should be 0');
                if (gov.recommended_next_actions.length !== 0) notes.push('recommended_next_actions should be empty');
                if (gov.unsafe_auto_actions.length !== 0) notes.push('unsafe_auto_actions should be empty');
                if (gov.human_review_actions.length !== 0) notes.push('human_review_actions should be empty');
                return notes;
            }
        },
        // 2. TRIMBOX_MISSING -> REBUILD_TRIMBOX (FIXABLE_AUTO, LOW risk) -> safe recommended action only
        {
            name: 'TRIMBOX_MISSING -> SAFE_AUTO_FIX_AVAILABLE',
            jobExtraData: { findings: [
                { id: 'TRIMBOX_MISSING', code: 'IND_GEOM_003', fixable: true, fix_method: 'REBUILD_TRIMBOX', repairStrategy: 'REBUILD_TRIMBOX', safeToAutofix: true, destructiveFixRisk: 'LOW' }
            ] },
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
                if (gov.total_findings !== 1) notes.push('total_findings should be 1');
                const rec = gov.recommended_next_actions.find(a => a.fix_id === 'REBUILD_TRIMBOX');
                if (!rec) notes.push('recommended_next_actions missing REBUILD_TRIMBOX');
                else if (rec.action !== 'SAFE_AUTO_FIX_AVAILABLE') notes.push('REBUILD_TRIMBOX action should be SAFE_AUTO_FIX_AVAILABLE');
                if (gov.unsafe_auto_actions.length !== 0) notes.push('unsafe_auto_actions should be empty for LOW-risk auto fix');
                if (gov.human_review_actions.length !== 0) notes.push('human_review_actions should be empty for LOW-risk auto fix');
                return notes;
            }
        },
        // 3. BLEED_MISSING -> APPLY_BLEED (FIXABLE_REVIEW_REQUIRED, MEDIUM risk, requires_human_review) ->
        //    recommended (review), unsafe-to-auto-apply, and human-review actions
        {
            name: 'BLEED_MISSING -> REQUEST_HUMAN_REVIEW + unsafe_auto + human_review',
            jobExtraData: { findings: [
                { id: 'BLEED_MISSING', code: 'IND_GEOM_002', fixable: true, fix_method: 'APPLY_BLEED', repairStrategy: 'APPLY_BLEED', destructiveFixRisk: 'MEDIUM' }
            ] },
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
                const rec = gov.recommended_next_actions.find(a => a.fix_id === 'APPLY_BLEED');
                if (!rec) notes.push('recommended_next_actions missing APPLY_BLEED');
                else if (rec.action !== 'REQUEST_HUMAN_REVIEW') notes.push('APPLY_BLEED action should be REQUEST_HUMAN_REVIEW');
                if (!gov.unsafe_auto_actions.some(a => a.fix_id === 'APPLY_BLEED')) notes.push('unsafe_auto_actions missing APPLY_BLEED');
                const review = gov.human_review_actions.find(a => a.fix_id === 'APPLY_BLEED');
                if (!review) notes.push('human_review_actions missing APPLY_BLEED');
                else if (review.operator_review_reason !== 'HUMAN_REVIEW_REQUIRED') notes.push('APPLY_BLEED operator_review_reason should be HUMAN_REVIEW_REQUIRED');
                return notes;
            }
        },
        // 4. TRANSPARENCY_PRESENT -> FLATTEN_TRANSPARENCY (NOT_IMPLEMENTED, visually sensitive, HIGH risk) ->
        //    not auto-recommended, but flagged unsafe and requiring human review
        {
            name: 'TRANSPARENCY_PRESENT -> not recommended, unsafe + human review (NOT_IMPLEMENTED)',
            jobExtraData: { findings: [
                { id: 'TRANSPARENCY_PRESENT', code: 'IND_TRANS_001', fixable: true, fix_method: 'FLATTEN_TRANSPARENCY', repairStrategy: 'FLATTEN_TRANSPARENCY', destructiveFixRisk: 'HIGH' }
            ] },
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
                if (gov.recommended_next_actions.some(a => a.fix_id === 'FLATTEN_TRANSPARENCY')) notes.push('FLATTEN_TRANSPARENCY should not appear in recommended_next_actions (NOT_IMPLEMENTED)');
                const unsafe = gov.unsafe_auto_actions.find(a => a.fix_id === 'FLATTEN_TRANSPARENCY');
                if (!unsafe) notes.push('unsafe_auto_actions missing FLATTEN_TRANSPARENCY');
                else if (unsafe.visual_sensitivity !== true) notes.push('FLATTEN_TRANSPARENCY unsafe entry should have visual_sensitivity=true');
                const review = gov.human_review_actions.find(a => a.fix_id === 'FLATTEN_TRANSPARENCY');
                if (!review) notes.push('human_review_actions missing FLATTEN_TRANSPARENCY');
                else if (review.operator_review_reason !== 'FIX_NOT_IMPLEMENTED') notes.push('FLATTEN_TRANSPARENCY operator_review_reason should be FIX_NOT_IMPLEMENTED');
                return notes;
            }
        },
        // 5. PAGE_SIZE_INCONSISTENT -> no fix strategy (NOT_FIXABLE) -> absent from all action lists
        {
            name: 'PAGE_SIZE_INCONSISTENT -> absent from all action lists (NOT_FIXABLE)',
            jobExtraData: { findings: [
                { id: 'PAGE_SIZE_INCONSISTENT', code: 'IND_GEOM_009' }
            ] },
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
                if (gov.recommended_next_actions.length !== 0) notes.push('recommended_next_actions should be empty for NOT_FIXABLE finding');
                if (gov.unsafe_auto_actions.length !== 0) notes.push('unsafe_auto_actions should be empty for NOT_FIXABLE finding');
                if (gov.human_review_actions.length !== 0) notes.push('human_review_actions should be empty for NOT_FIXABLE finding');
                return notes;
            }
        },
        // 6. Multiple findings -> action lists accumulate across findings
        {
            name: 'multiple findings -> action lists accumulate',
            jobExtraData: { findings: [
                { id: 'TRIMBOX_MISSING', code: 'IND_GEOM_003', fixable: true, fix_method: 'REBUILD_TRIMBOX', repairStrategy: 'REBUILD_TRIMBOX', safeToAutofix: true, destructiveFixRisk: 'LOW' },
                { id: 'BLEED_MISSING', code: 'IND_GEOM_002', fixable: true, fix_method: 'APPLY_BLEED', repairStrategy: 'APPLY_BLEED', destructiveFixRisk: 'MEDIUM' },
                { id: 'TRANSPARENCY_PRESENT', code: 'IND_TRANS_001', fixable: true, fix_method: 'FLATTEN_TRANSPARENCY', repairStrategy: 'FLATTEN_TRANSPARENCY', destructiveFixRisk: 'HIGH' }
            ] },
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
                if (gov.total_findings !== 3) notes.push('total_findings should be 3');
                if (gov.recommended_next_actions.length !== 2) notes.push('recommended_next_actions should have 2 entries (REBUILD_TRIMBOX, APPLY_BLEED)');
                if (gov.unsafe_auto_actions.length !== 2) notes.push('unsafe_auto_actions should have 2 entries (APPLY_BLEED, FLATTEN_TRANSPARENCY)');
                if (gov.human_review_actions.length !== 2) notes.push('human_review_actions should have 2 entries (APPLY_BLEED, FLATTEN_TRANSPARENCY)');
                if (gov.unsafe_auto_actions.some(a => a.fix_id === 'REBUILD_TRIMBOX')) notes.push('REBUILD_TRIMBOX should never appear in unsafe_auto_actions');
                return notes;
            }
        },
        // 7. REGRESSION: recommendation_governance present in fix_audit.json and delta_report.json
        //    with required fields, governance invariants, and listed as a governance domain.
        {
            name: 'REGRESSION: recommendation_governance present with required fields and invariants',
            jobExtraData: { findings: [
                { id: 'TRIMBOX_MISSING', code: 'IND_GEOM_003', fixable: true, fix_method: 'REBUILD_TRIMBOX', repairStrategy: 'REBUILD_TRIMBOX', safeToAutofix: true, destructiveFixRisk: 'LOW' }
            ] },
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
                if (!audit.recommendation_governance) notes.push('recommendation_governance missing from fix_audit.json');
                if (!delta.recommendation_governance) notes.push('recommendation_governance missing from delta_report.json');
                const requiredFields = ['recommendation_signals_available', 'total_findings', 'recommended_next_actions', 'unsafe_auto_actions', 'human_review_actions', 'recommendation_authority', 'auto_apply_authority', 'production_certified', 'standard_certified', 'warnings', 'evidence'];
                for (const field of requiredFields) {
                    if (!(field in gov)) notes.push(`recommendation_governance missing field: ${field}`);
                }
                if (gov.recommendation_authority !== false) notes.push('recommendation_authority must be false (advisory only)');
                if (gov.auto_apply_authority !== false) notes.push('auto_apply_authority must be false (advisory only)');
                if (gov.production_certified !== false) notes.push('production_certified must be false (no overclaim)');
                if (gov.standard_certified !== false) notes.push('standard_certified must be false (no overclaim)');
                if (!Array.isArray(audit.audit_bundle_governance?.governance_domains) || !audit.audit_bundle_governance.governance_domains.includes('recommendation_governance')) {
                    notes.push('audit_bundle_governance.governance_domains should include recommendation_governance');
                }
                return notes;
            }
        }
    ];

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase75b-worker-test-${Date.now()}`);
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
                jobId: 'job-75b',
                tenantId: 'tenant-75b',
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

            const gov = audit.recommendation_governance;

            if (!gov) {
                pass = false;
                notes.push('recommendation_governance missing from fix_audit.json');
            } else {
                const checkNotes = scenario.checks(gov, audit, delta);
                checkNotes.forEach(n => { pass = false; notes.push(n); });
            }

            results.push({
                scenario: scenario.name,
                status: result.status,
                recommendation_governance: gov || {},
                total_findings: gov ? gov.total_findings : null,
                recommended_next_actions: gov ? gov.recommended_next_actions : [],
                unsafe_auto_actions: gov ? gov.unsafe_auto_actions : [],
                human_review_actions: gov ? gov.human_review_actions : [],
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

    const reportJsonPath = path.join(REPORTS_DIR, 'phase75b_worker_recommendation_governance.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase75b_worker_recommendation_governance.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '75B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        results
    }, { spaces: 2 });

    let md = `# Phase 75B — Worker Recommendation Governance\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n\n`;
    md += `Validates that \`recommendation_governance\` is emitted in \`fix_audit.json\` v2 and \`delta_report.json\`, derived from the Engine's \`recommendation_signals\` (Phase 75A) and the job's source findings. Enforces:\n\n`;
    md += `- Each finding's per-finding signal (\`fixability\`, \`risk_level\`, \`visual_sensitivity\`, \`operator_review_reason\`) is aggregated into \`recommended_next_actions\`, \`unsafe_auto_actions\`, and \`human_review_actions\`.\n`;
    md += `- \`recommended_next_actions\` only includes findings that are \`FIXABLE_AUTO\` (action=SAFE_AUTO_FIX_AVAILABLE) or \`FIXABLE_REVIEW_REQUIRED\` (action=REQUEST_HUMAN_REVIEW).\n`;
    md += `- \`unsafe_auto_actions\` flags any finding that is visually sensitive, HIGH/CRITICAL risk, or requires review — these must never be auto-applied without approval.\n`;
    md += `- \`human_review_actions\` lists every finding with a non-null \`operator_review_reason\`.\n`;
    md += `- \`recommendation_authority\`, \`auto_apply_authority\`, \`production_certified\`, and \`standard_certified\` are always \`false\` — recommendations are advisory inputs to Phase 75D only, never a certification or auto-apply authority.\n`;
    md += `- \`recommendation_governance\` is listed in \`audit_bundle_governance.governance_domains\`.\n\n`;
    md += `## Results\n\n`;

    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass ? '✅' : '❌'}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Status:** ${res.status}\n`;
        md += `- **total_findings:** ${res.total_findings}\n`;
        md += `- **recommended_next_actions:** ${(res.recommended_next_actions || []).map(a => `${a.fix_id}:${a.action}`).join(', ') || 'none'}\n`;
        md += `- **unsafe_auto_actions:** ${(res.unsafe_auto_actions || []).map(a => a.fix_id).join(', ') || 'none'}\n`;
        md += `- **human_review_actions:** ${(res.human_review_actions || []).map(a => `${a.fix_id}:${a.operator_review_reason}`).join(', ') || 'none'}\n\n`;
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
