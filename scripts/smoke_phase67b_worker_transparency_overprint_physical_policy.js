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
const ENGINE_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase67a_engine_transparency_overprint_physical.json');

const PHYSICAL_FIXES = ['FLATTEN_TRANSPARENCY', 'NORMALIZE_BLEND_MODES', 'FLATTEN_OVERPRINT', 'SIMULATE_OVERPRINT_PREVIEW'];

function toMockEngineResult(engineResult) {
    const capabilityIds = (engineResult.capability || '').split(',').map(s => s.trim()).filter(Boolean);
    const fixId = capabilityIds[0] || engineResult.capability;

    const fixEntry = {
        fix_id: fixId,
        status: engineResult.status,
        reason: (engineResult.notes && engineResult.notes[0]) || engineResult.skip_reason || undefined,
        rendering_safety_proven: engineResult.rendering_safety_proven,
        visual_change_expected: engineResult.visual_change_expected,
        evidence: engineResult.evidence || undefined
    };

    const buckets = { applied_fixes: [], skipped_fixes: [], failed_fixes: [] };
    if (engineResult.status === 'APPLIED') buckets.applied_fixes.push(fixEntry);
    else if (engineResult.status === 'FAILED') buckets.failed_fixes.push(fixEntry);
    else buckets.skipped_fixes.push(fixEntry);

    return {
        ...buckets,
        requires_human_review: engineResult.requires_human_review,
        production_certified: engineResult.production_certified,
        production_safe: engineResult.production_safe,
        rendering_safety_proven: engineResult.rendering_safety_proven,
        visual_change_expected: engineResult.visual_change_expected
    };
}

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    let engineScenarios = [];

    if (await fs.pathExists(ENGINE_REPORT_PATH)) {
        const engineReport = await fs.readJson(ENGINE_REPORT_PATH);
        engineScenarios = (engineReport.results || [])
            .filter(r => r.capability && PHYSICAL_FIXES.includes((r.capability || '').split(',')[0].trim()))
            .map(r => ({
                name: r.scenario,
                mockEngineResult: toMockEngineResult(r)
            }));
        inputMode = 'ENGINE_REPORT';
        console.log(`[TEST] Loaded ${engineScenarios.length} scenarios from Engine report (67A).`);
    } else {
        console.log('[TEST] Engine 67A report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
        engineScenarios = [
            {
                name: 'SYNTHETIC: FLATTEN_TRANSPARENCY skipped unsupported',
                mockEngineResult: {
                    applied_fixes: [],
                    skipped_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', rendering_safety_proven: false, visual_change_expected: true, evidence: { rendering_safety_proven: false, visual_change_expected: true, implemented: false } }],
                    failed_fixes: []
                }
            },
            {
                name: 'SYNTHETIC: NORMALIZE_BLEND_MODES skipped unsupported',
                mockEngineResult: {
                    applied_fixes: [],
                    skipped_fixes: [{ fix_id: 'NORMALIZE_BLEND_MODES', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', rendering_safety_proven: false, evidence: { rendering_safety_proven: false, implemented: false } }],
                    failed_fixes: []
                }
            },
            {
                name: 'SYNTHETIC: FLATTEN_OVERPRINT skipped unsupported',
                mockEngineResult: {
                    applied_fixes: [],
                    skipped_fixes: [{ fix_id: 'FLATTEN_OVERPRINT', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', rendering_safety_proven: false, visual_change_expected: true, evidence: { rendering_safety_proven: false, visual_change_expected: true, implemented: false } }],
                    failed_fixes: []
                }
            },
            {
                name: 'SYNTHETIC: SIMULATE_OVERPRINT_PREVIEW skipped unsupported',
                mockEngineResult: {
                    applied_fixes: [],
                    skipped_fixes: [{ fix_id: 'SIMULATE_OVERPRINT_PREVIEW', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', rendering_safety_proven: false, evidence: { rendering_safety_proven: false, implemented: false } }],
                    failed_fixes: []
                }
            },
            {
                name: 'SYNTHETIC: mixed physical fixes all skipped',
                mockEngineResult: {
                    applied_fixes: [],
                    skipped_fixes: [
                        { fix_id: 'FLATTEN_TRANSPARENCY', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', rendering_safety_proven: false, evidence: { rendering_safety_proven: false, implemented: false } },
                        { fix_id: 'FLATTEN_OVERPRINT', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', rendering_safety_proven: false, evidence: { rendering_safety_proven: false, implemented: false } }
                    ],
                    failed_fixes: []
                }
            },
            {
                name: 'SYNTHETIC: clean control no action',
                mockEngineResult: { applied_fixes: [], skipped_fixes: [], failed_fixes: [] }
            }
        ];
    }

    engineScenarios.push(
        {
            name: 'REGRESSION: physical flatten APPLIED must force FIXED_REVIEW_REQUIRED',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', rendering_safety_proven: false, visual_change_expected: true, evidence: { rendering_safety_proven: false, visual_change_expected: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true,
                production_safe: true
            }
        },
        {
            name: 'REGRESSION: rendering_safety_proven must never leak as true',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'FLATTEN_OVERPRINT', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', rendering_safety_proven: false, evidence: { rendering_safety_proven: false, implemented: false } }],
                failed_fixes: [],
                rendering_safety_proven: true
            }
        },
        {
            name: 'REGRESSION: visual_change_expected must be preserved from evidence',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', visual_change_expected: true, rendering_safety_proven: false, evidence: { visual_change_expected: true, rendering_safety_proven: false, implemented: false } }],
                failed_fixes: []
            }
        },
        {
            name: 'REGRESSION: standards overclaim from physical fix must be rejected',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', rendering_safety_proven: false, evidence: { rendering_safety_proven: false } }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true,
                pdfx_compliance_claimed: true,
                pdfa_compliance_claimed: true,
                compliance_claim_allowed: true
            }
        },
        {
            name: 'REGRESSION: evidence preservation across applied/skipped/failed buckets',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'FLATTEN_TRANSPARENCY', status: 'APPLIED', rendering_safety_proven: false, visual_change_expected: true, evidence: { rendering_safety_proven: false, visual_change_expected: true } }],
                skipped_fixes: [{ fix_id: 'NORMALIZE_BLEND_MODES', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { rendering_safety_proven: false, implemented: false } }],
                failed_fixes: [{ fix_id: 'FLATTEN_OVERPRINT', status: 'FAILED', evidence: { rendering_safety_proven: false, error: 'Tool error' } }]
            }
        }
    );

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase67b-worker-test-${Date.now()}`);
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
                jobId: 'job-67b',
                tenantId: 'tenant-67b',
                input: { fileUrl: mockInput, findings: [{ id: 'TRANSPARENCY_PRESENT' }] },
                fixes: ['FLATTEN_TRANSPARENCY']
            },
            updateProgress: async () => {}
        };

        let pass = true;
        const notes = [];

        try {
            const result = await AutofixProcessor.process(job, console);

            const fixAuditPath = path.join(testDir, 'fix_audit.json');
            const deltaReportPath = path.join(testDir, 'delta_report.json');

            const audit = await fs.readJson(fixAuditPath);
            const delta = await fs.readJson(deltaReportPath);

            const gov = audit.transparency_overprint_physical_governance;
            const trust = audit.artifact_trust;

            if (!gov) { pass = false; notes.push('transparency_overprint_physical_governance missing in fix_audit.json'); }
            if (!delta.transparency_overprint_physical_governance) { pass = false; notes.push('transparency_overprint_physical_governance missing in delta_report.json'); }

            const allFixes = [
                ...(scenario.mockEngineResult.applied_fixes || []),
                ...(scenario.mockEngineResult.skipped_fixes || []),
                ...(scenario.mockEngineResult.failed_fixes || [])
            ];
            const hasPhysicalActivity = allFixes.length > 0;

            if (gov && hasPhysicalActivity) {
                if (!gov.review_required) { pass = false; notes.push('review_required not set when physical fix activity present'); }
                if (gov.production_certified) { pass = false; notes.push('Governance leaked production_certified=true'); }
                if (gov.standard_certified) { pass = false; notes.push('Governance leaked standard_certified=true'); }
                if (gov.compliance_claim_allowed) { pass = false; notes.push('Governance leaked compliance_claim_allowed=true'); }
                if (!trust || trust.review_required !== true) { pass = false; notes.push('artifact_trust.review_required not forced true'); }
                if (!trust || trust.trust_level !== 'FIXED_REVIEW_REQUIRED') { pass = false; notes.push('artifact_trust.trust_level not FIXED_REVIEW_REQUIRED'); }
                if (trust && trust.certified_pdf_allowed) { pass = false; notes.push('artifact_trust.certified_pdf_allowed leaked true'); }
                if (trust && (trust.standard_certified || trust.pdfx_compliance_claimed || trust.pdfa_compliance_claimed || trust.compliance_claim_allowed)) {
                    pass = false;
                    notes.push('artifact_trust standards/compliance fields not forced false');
                }
            }

            // Evidence preservation across all status buckets
            for (const f of allFixes) {
                const evidenceObj = gov && gov.evidence && gov.evidence[f.fix_id];
                if (!evidenceObj) {
                    pass = false;
                    notes.push(`No per-fix evidence object preserved for ${f.fix_id} (status=${f.status})`);
                }
            }

            // rendering_safety_proven must never leak as true from a skipped/unsupported fix
            if (gov && gov.rendering_safety_proven === true) {
                const hasAppliedProvenFix = (scenario.mockEngineResult.applied_fixes || []).some(
                    f => f.evidence && f.evidence.rendering_safety_proven === true
                );
                if (!hasAppliedProvenFix) {
                    pass = false;
                    notes.push('rendering_safety_proven=true leaked when no applied fix has evidence of it');
                }
            }

            // visual_change_expected must be preserved when present in evidence
            for (const f of allFixes) {
                if (f.evidence && f.evidence.visual_change_expected === true) {
                    if (gov && gov.visual_change_expected !== true) {
                        pass = false;
                        notes.push(`visual_change_expected not propagated to governance for ${f.fix_id}`);
                    }
                    break;
                }
            }

            // Physical flatten APPLIED regression
            if (scenario.name.startsWith('REGRESSION: physical flatten APPLIED')) {
                if (!trust || trust.trust_level !== 'FIXED_REVIEW_REQUIRED') {
                    pass = false;
                    notes.push('Physical flatten APPLIED did not force artifact_trust=FIXED_REVIEW_REQUIRED');
                }
                if (trust && trust.production_certified === true) {
                    pass = false;
                    notes.push('production_certified leaked true despite physical flatten APPLIED');
                }
            }

            // Standards overclaim regression
            if (scenario.name.startsWith('REGRESSION: standards overclaim')) {
                const sc = audit.standards_certification_governance || {};
                if (sc.pdfx_compliance_claimed || sc.pdfa_compliance_claimed || sc.compliance_claim_allowed || (trust && (trust.standard_certified || trust.production_certified))) {
                    pass = false;
                    notes.push('Worker propagated a standards/production overclaim from a physical transparency fix');
                }
            }

            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: result.status,
                transparency_overprint_physical_governance: gov || {},
                artifact_trust: trust || {},
                evidence_present: Object.keys((gov && gov.evidence) || {}).length > 0,
                rendering_safety_proven: gov ? gov.rendering_safety_proven : undefined,
                visual_change_expected: gov ? gov.visual_change_expected : undefined,
                review_required: trust ? trust.review_required : undefined,
                production_certified: trust ? trust.production_certified : undefined,
                standard_certified: trust ? trust.standard_certified : undefined,
                pass,
                notes: notes.length ? notes.join('; ') : 'OK'
            });
        } catch (err) {
            console.error(err);
            pass = false;
            results.push({ scenario: scenario.name, status: 'ERROR', pass: false, notes: err.message });
        }

        if (!pass) smokePassed = false;
    }

    const reportJsonPath = path.join(REPORTS_DIR, 'phase67b_worker_transparency_overprint_physical_policy.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase67b_worker_transparency_overprint_physical_policy.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '67B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        input_mode: inputMode,
        results
    }, { spaces: 2 });

    let md = `# Phase 67B — Worker Transparency / Overprint Physical Governance Policy\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\nValidates that transparency_overprint_physical_governance, evidence (APPLIED/SKIPPED/FAILED), and artifact_trust remain conservative and intact when Worker policy ingests Engine 67A transparency/overprint physical fix scenarios (FLATTEN_TRANSPARENCY, NORMALIZE_BLEND_MODES, FLATTEN_OVERPRINT, SIMULATE_OVERPRINT_PREVIEW). Enforces: review_required=true always when any physical fix is attempted, artifact_trust=FIXED_REVIEW_REQUIRED for any physical flatten arriving as APPLIED, rendering_safety_proven never leaked as true from unsupported/skipped fixes, visual_change_expected preserved from evidence, and no standards/production overclaims leak through.\n\n`;
    md += `## Results\n\n`;
    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Review Required:** ${res.review_required}\n`;
        md += `- **Production Certified:** ${res.production_certified}\n`;
        md += `- **Standard Certified:** ${res.standard_certified}\n`;
        md += `- **Rendering Safety Proven:** ${res.rendering_safety_proven}\n`;
        md += `- **Visual Change Expected:** ${res.visual_change_expected}\n`;
        md += `- **Evidence Present:** ${res.evidence_present}\n\n`;
    }

    await fs.writeFile(reportMdPath, md);
    console.log(`[TEST] Reports generated at ${REPORTS_DIR}`);

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
