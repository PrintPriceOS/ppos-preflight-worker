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

    // Scenarios covering machine_readiness_governance derivation
    const scenarios = [
        // 1. No findings, no metadata -> advisory unknowns, no incompatibilities
        {
            name: 'no findings, no metadata -> machine_match_required=false',
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
                if (!gov.machine_capability_signals) notes.push('machine_capability_signals missing');
                if (gov.machine_match_required !== false) notes.push('machine_match_required should be false with no risk signals');
                if (gov.incompatible_machine_reasons.length !== 0) notes.push('incompatible_machine_reasons should be empty');
                if (!gov.warnings.includes('PAGE_COUNT_UNAVAILABLE')) notes.push('warnings should include PAGE_COUNT_UNAVAILABLE');
                if (!gov.warnings.includes('PAGE_SIZE_UNAVAILABLE')) notes.push('warnings should include PAGE_SIZE_UNAVAILABLE');
                return notes;
            }
        },
        // 2. RGB images present -> requires CMYK conversion -> machine_match_required=true
        {
            name: 'RGB images present -> REQUIRES_CMYK_CONVERSION',
            jobExtraData: { findings: [{ id: 'RGB_IMAGES_PRESENT' }] },
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
                if (gov.machine_capability_signals.color_signals.rgb_detected !== true) notes.push('rgb_detected should be true');
                if (gov.machine_capability_signals.media_requirements.requires_cmyk_conversion !== true) notes.push('requires_cmyk_conversion should be true');
                if (gov.machine_match_required !== true) notes.push('machine_match_required should be true');
                if (!gov.incompatible_machine_reasons.includes('REQUIRES_CMYK_CONVERSION')) notes.push('incompatible_machine_reasons should include REQUIRES_CMYK_CONVERSION');
                return notes;
            }
        },
        // 3. Bleed missing finding -> BLEED_MISSING reason
        {
            name: 'bleed missing finding -> BLEED_MISSING',
            jobExtraData: { findings: [{ id: 'BLEED_MISSING' }] },
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
                if (gov.machine_capability_signals.finishing_signals.bleed_missing !== true) notes.push('bleed_missing should be true');
                if (gov.machine_match_required !== true) notes.push('machine_match_required should be true');
                if (!gov.incompatible_machine_reasons.includes('BLEED_MISSING')) notes.push('incompatible_machine_reasons should include BLEED_MISSING');
                return notes;
            }
        },
        // 4. TAC exceeded -> ink_risk=HIGH -> INK_RISK_HIGH reason
        {
            name: 'TAC exceeded -> INK_RISK_HIGH',
            jobExtraData: { findings: [{ id: 'COLOR_TOTAL_INK_COVERAGE_EXCEEDED' }] },
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
                if (gov.machine_capability_signals.ink_signals.ink_risk !== 'HIGH') notes.push('ink_risk should be HIGH');
                if (!gov.incompatible_machine_reasons.includes('INK_RISK_HIGH')) notes.push('incompatible_machine_reasons should include INK_RISK_HIGH');
                if (gov.incompatible_machine_reasons.includes('INK_RISK_MEDIUM')) notes.push('should not include INK_RISK_MEDIUM when HIGH');
                return notes;
            }
        },
        // 5. PDFX_INVALID standard -> STANDARD_INVALID reason
        {
            name: 'PDFX_INVALID standard -> STANDARD_INVALID',
            jobExtraData: { findings: [{ id: 'PDFX_INVALID' }] },
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
                if (gov.machine_capability_signals.standards_signals.standard_status !== 'INVALID') notes.push('standard_status should be INVALID');
                if (!gov.incompatible_machine_reasons.includes('STANDARD_INVALID')) notes.push('incompatible_machine_reasons should include STANDARD_INVALID');
                return notes;
            }
        },
        // 6. Multiple risk findings -> multiple incompatibility reasons accumulate
        {
            name: 'multiple findings -> multiple incompatible_machine_reasons',
            jobExtraData: { findings: [
                { id: 'RGB_IMAGES_PRESENT' },
                { id: 'BLEED_MISSING' },
                { id: 'CROP_MARKS_MISSING' },
                { id: 'GEOM_MIXED_PAGE_ORIENTATION' }
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
                if (gov.machine_match_required !== true) notes.push('machine_match_required should be true');
                if (!gov.incompatible_machine_reasons.includes('REQUIRES_CMYK_CONVERSION')) notes.push('missing REQUIRES_CMYK_CONVERSION');
                if (!gov.incompatible_machine_reasons.includes('FINISHING_MARKS_RISK_HIGH')) notes.push('missing FINISHING_MARKS_RISK_HIGH (bleed+crop marks missing)');
                if (!gov.incompatible_machine_reasons.includes('MIXED_ORIENTATION_DETECTED')) notes.push('missing MIXED_ORIENTATION_DETECTED');
                if (gov.incompatible_machine_reasons.length < 3) notes.push('expected at least 3 incompatibility reasons');
                return notes;
            }
        },
        // 7. REGRESSION: machine_readiness_governance present in fix_audit.json and delta_report.json with required fields and governance invariants
        {
            name: 'REGRESSION: machine_readiness_governance present with required fields and invariants',
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
                if (!audit.machine_readiness_governance) notes.push('machine_readiness_governance missing from fix_audit.json');
                if (!delta.machine_readiness_governance) notes.push('machine_readiness_governance missing from delta_report.json');
                const requiredFields = ['machine_capability_signals', 'machine_match_required', 'incompatible_machine_reasons', 'warnings', 'machine_match_authority', 'production_certified', 'standard_certified', 'evidence'];
                for (const field of requiredFields) {
                    if (!(field in gov)) notes.push(`machine_readiness_governance missing field: ${field}`);
                }
                if (gov.machine_match_authority !== false) notes.push('machine_match_authority must be false (advisory only)');
                if (gov.production_certified !== false) notes.push('production_certified must be false (no overclaim)');
                if (gov.standard_certified !== false) notes.push('standard_certified must be false (no overclaim)');
                // Even with STANDARD_VALIDATION_PASSED, signals never imply certification.
                if (gov.machine_capability_signals.machine_capability_signals_governance.production_certified !== false) {
                    notes.push('machine_capability_signals_governance.production_certified must be false');
                }
                if (gov.machine_capability_signals.machine_capability_signals_governance.standard_certified !== false) {
                    notes.push('machine_capability_signals_governance.standard_certified must be false');
                }
                return notes;
            }
        }
    ];

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase73b-worker-test-${Date.now()}`);
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
                jobId: 'job-73b',
                tenantId: 'tenant-73b',
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

            const gov = audit.machine_readiness_governance;

            if (!gov) {
                pass = false;
                notes.push('machine_readiness_governance missing from fix_audit.json');
            } else {
                const checkNotes = scenario.checks(gov, audit, delta);
                checkNotes.forEach(n => { pass = false; notes.push(n); });
            }

            results.push({
                scenario: scenario.name,
                status: result.status,
                machine_readiness_governance: gov || {},
                machine_match_required: gov ? gov.machine_match_required : null,
                incompatible_machine_reasons: gov ? gov.incompatible_machine_reasons : [],
                warnings: gov ? gov.warnings : [],
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

    const reportJsonPath = path.join(REPORTS_DIR, 'phase73b_worker_machine_readiness_governance.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase73b_worker_machine_readiness_governance.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '73B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        results
    }, { spaces: 2 });

    let md = `# Phase 73B — Worker Machine Readiness Governance\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n\n`;
    md += `Validates that \`machine_readiness_governance\` is emitted in \`fix_audit.json\` v2 and \`delta_report.json\`, derived from the Engine's \`machine_capability_signals\` (Phase 73A) and the job's source findings. Enforces:\n\n`;
    md += `- \`machine_capability_signals\` (page/color/ink/finishing/standards/media signals) are preserved verbatim.\n`;
    md += `- \`machine_match_required\` is true whenever any signal indicates a potential machine-matching constraint (CMYK conversion, missing bleed, ink risk, finishing risk, inconsistent page geometry, or standards risk).\n`;
    md += `- \`incompatible_machine_reasons\` lists the advisory reason codes driving \`machine_match_required\`.\n`;
    md += `- \`machine_match_authority\`, \`production_certified\`, and \`standard_certified\` are always \`false\` — signals are advisory inputs to Phase 73D machine assignment only, never a certification authority.\n\n`;
    md += `## Results\n\n`;

    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass ? '✅' : '❌'}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Status:** ${res.status}\n`;
        md += `- **machine_match_required:** ${res.machine_match_required}\n`;
        md += `- **incompatible_machine_reasons:** ${(res.incompatible_machine_reasons || []).join(', ') || 'none'}\n`;
        md += `- **warnings:** ${(res.warnings || []).join(', ') || 'none'}\n\n`;
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
