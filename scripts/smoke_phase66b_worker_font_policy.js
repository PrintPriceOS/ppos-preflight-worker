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
const ENGINE_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase66a_engine_font_fixes.json');

// Map an Engine 66A regression result entry into a synthetic Engine autofixPdf-shaped payload.
function toMockEngineResult(engineResult) {
    const capabilityIds = (engineResult.capability || '').split(',').map(s => s.trim()).filter(Boolean);
    const fixId = capabilityIds[0] || engineResult.capability;

    const fixEntry = {
        fix_id: fixId,
        status: engineResult.status,
        reason: (engineResult.notes && engineResult.notes[0]) || engineResult.skip_reason || undefined,
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
        standard_certified: engineResult.standard_certified,
        pdfx_compliance_claimed: engineResult.pdfx_compliance_claimed,
        pdfa_compliance_claimed: engineResult.pdfa_compliance_claimed,
        compliance_claim_allowed: engineResult.compliance_claim_allowed
    };
}

const FONT_FIXES = ['EMBED_FONTS', 'SUBSET_EMBEDDED_FONTS', 'OUTLINE_TYPE3_FONTS', 'REPAIR_FONT_ENCODING', 'FLAG_MISSING_GLYPHS_UNFIXABLE'];
const DESTRUCTIVE_OUTLINE_FIXES = ['OUTLINE_TYPE3_FONTS', 'REPAIR_FONT_ENCODING', 'EMBED_FONTS', 'SUBSET_EMBEDDED_FONTS'];

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    let engineScenarios = [];

    if (await fs.pathExists(ENGINE_REPORT_PATH)) {
        const engineReport = await fs.readJson(ENGINE_REPORT_PATH);
        engineScenarios = (engineReport.results || [])
            .filter(r => r.capability && FONT_FIXES.includes((r.capability || '').split(',')[0].trim()))
            .map(r => ({
                name: r.scenario,
                mockEngineResult: toMockEngineResult(r)
            }));
        inputMode = 'ENGINE_REPORT';
        console.log(`[TEST] Loaded ${engineScenarios.length} scenarios from Engine report (66A).`);
    } else {
        console.log('[TEST] Engine 66A report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
        engineScenarios = [
            { name: 'SYNTHETIC: EMBED_FONTS skipped — no font source', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'EMBED_FONTS', status: 'SKIPPED_UNAVAILABLE_FONT_SOURCE', reason: 'SKIPPED_UNAVAILABLE_FONT_SOURCE', evidence: { fonts_embedded: false, font_embedding_skipped: true, font_source_available: false } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: SUBSET_EMBEDDED_FONTS skipped unsupported', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'SUBSET_EMBEDDED_FONTS', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { implemented: false } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: OUTLINE_TYPE3_FONTS detected and skipped', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'OUTLINE_TYPE3_FONTS', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { type3_fonts_detected: true, implemented: false } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: REPAIR_FONT_ENCODING skipped unsupported', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'REPAIR_FONT_ENCODING', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { implemented: false } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: FLAG_MISSING_GLYPHS_UNFIXABLE flagged', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'FLAG_MISSING_GLYPHS_UNFIXABLE', status: 'SKIPPED_UNSUPPORTED', reason: 'GLYPHS_MISSING_UNFIXABLE', evidence: { implemented: false, glyphs_missing_unfixable: true, glyph_synthesis_performed: false } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: mixed font fixes (embedding + Type3)', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'EMBED_FONTS', status: 'SKIPPED_UNAVAILABLE_FONT_SOURCE', reason: 'SKIPPED_UNAVAILABLE_FONT_SOURCE', evidence: { fonts_embedded: false, font_embedding_skipped: true, font_source_available: false } }, { fix_id: 'OUTLINE_TYPE3_FONTS', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { type3_fonts_detected: true, implemented: false } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: clean control no action', mockEngineResult: { applied_fixes: [], skipped_fixes: [], failed_fixes: [] } }
        ];
    }

    // Extra regression-only scenarios: overclaim / certified.pdf / evidence preservation / no glyph synthesis guards
    engineScenarios.push(
        {
            name: 'REGRESSION: standards overclaim from font fix must be rejected',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'EMBED_FONTS', status: 'APPLIED', evidence: { fonts_embedded: true, font_source_available: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                production_certified: true,
                pdfx_compliance_claimed: true,
                pdfa_compliance_claimed: true,
                compliance_claim_allowed: true
            }
        },
        {
            name: 'REGRESSION: certified.pdf filename must not be trusted by name',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'REPAIR_FONT_ENCODING', status: 'APPLIED', evidence: { font_encoding_repaired: true } }],
                skipped_fixes: [],
                failed_fixes: [],
                artifacts: { fixed_pdf: { path: 'certified.pdf' } }
            }
        },
        {
            name: 'REGRESSION: evidence preservation across applied/skipped/failed buckets',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'SUBSET_EMBEDDED_FONTS', status: 'APPLIED', evidence: { embedded_fonts_subset: 1 } }],
                skipped_fixes: [{ fix_id: 'FLAG_MISSING_GLYPHS_UNFIXABLE', status: 'SKIPPED_UNSUPPORTED', reason: 'GLYPHS_MISSING_UNFIXABLE', evidence: { implemented: false, glyphs_missing_unfixable: true, glyph_synthesis_performed: false, limitations: ['No safe glyph synthesis pipeline available.'] } }],
                failed_fixes: [{ fix_id: 'EMBED_FONTS', status: 'FAILED', evidence: { fonts_embedded: false, warnings: ['Tool error while embedding fonts.'] } }]
            }
        },
        {
            name: 'REGRESSION: glyph synthesis must never be reported as performed',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'FLAG_MISSING_GLYPHS_UNFIXABLE', status: 'SKIPPED_UNSUPPORTED', reason: 'GLYPHS_MISSING_UNFIXABLE', evidence: { implemented: false, glyphs_missing_unfixable: true, glyph_synthesis_performed: false } }],
                failed_fixes: []
            }
        },
        {
            name: 'REGRESSION: destructive outline operations must force review',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'OUTLINE_TYPE3_FONTS', status: 'APPLIED', evidence: { type3_fonts_detected: true, type3_fonts_outlined: 1 } }],
                skipped_fixes: [],
                failed_fixes: []
            }
        }
    );

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase66b-worker-test-${Date.now()}`);
    process.env.TEST_DIR = testDir;
    await fs.ensureDir(testDir);
    const mockInput = path.join(testDir, 'input.pdf');
    await fs.writeFile(mockInput, '%PDF-1.4\nTest');
    const mockOutput = path.join(testDir, 'mock_engine_output.pdf');
    await fs.writeFile(mockOutput, '%PDF-1.4\nTest Fixed');
    const mockSanitized = path.join(testDir, 'sanitized_input.pdf');
    await fs.writeFile(mockSanitized, '%PDF-1.4\nSanitized');

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
                jobId: 'job-66b',
                tenantId: 'tenant-66b',
                input: { fileUrl: mockInput, findings: [{ id: 'IND_FONT_001' }] },
                fixes: ['EMBED_FONTS']
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

            const gov = audit.font_governance;
            const trust = audit.artifact_trust;

            if (!gov) { pass = false; notes.push('font_governance missing in fix_audit.json'); }
            if (!delta.font_governance) { pass = false; notes.push('font_governance missing in delta_report.json'); }

            const allFixes = [
                ...(scenario.mockEngineResult.applied_fixes || []),
                ...(scenario.mockEngineResult.skipped_fixes || []),
                ...(scenario.mockEngineResult.failed_fixes || [])
            ];
            const hasFontActivity = allFixes.length > 0;

            if (gov && hasFontActivity) {
                if (!gov.review_required) { pass = false; notes.push('Review not required when font fix activity present'); }
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

                // Destructive/outline operations must be marked review-required
                const destructiveAttempted = allFixes.filter(f => DESTRUCTIVE_OUTLINE_FIXES.includes(f.fix_id));
                if (destructiveAttempted.length > 0) {
                    if (!gov.review_required) { pass = false; notes.push('Destructive font operation attempted but review_required not forced'); }
                    for (const f of destructiveAttempted) {
                        if (!gov.review_required_reasons.includes(f.fix_id)) {
                            pass = false;
                            notes.push(`Destructive font operation ${f.fix_id} not listed in review_required_reasons`);
                        }
                    }
                    if (!gov.destructive_operations_attempted.includes(destructiveAttempted[0].fix_id)) {
                        pass = false;
                        notes.push('destructive_operations_attempted did not record attempted destructive font operation');
                    }
                }
            }

            // Evidence preservation across all status buckets (APPLIED/SKIPPED/FAILED)
            for (const f of allFixes) {
                const evidenceObj = gov && gov.evidence && gov.evidence[f.fix_id];
                if (!evidenceObj) {
                    pass = false;
                    notes.push(`No per-fix evidence object preserved for ${f.fix_id} (status=${f.status})`);
                }
            }

            // Specific evidence field preservation checks
            for (const f of allFixes) {
                if (f.evidence) {
                    if (f.evidence.fonts_embedded === true && gov && gov.fonts_embedded !== true) {
                        pass = false;
                        notes.push(`fonts_embedded not propagated to governance for ${f.fix_id}`);
                    }
                    if (f.evidence.font_embedding_skipped === true && gov && gov.font_embedding_skipped !== true) {
                        pass = false;
                        notes.push(`font_embedding_skipped not propagated to governance for ${f.fix_id}`);
                    }
                    if (f.evidence.type3_fonts_detected === true && gov && gov.type3_fonts_detected !== true) {
                        pass = false;
                        notes.push(`type3_fonts_detected not propagated to governance for ${f.fix_id}`);
                    }
                    if (f.evidence.glyphs_missing_unfixable === true && gov && gov.glyphs_missing_unfixable !== true) {
                        pass = false;
                        notes.push(`glyphs_missing_unfixable not propagated to governance for ${f.fix_id}`);
                    }
                    if (typeof f.evidence.font_source_available === 'boolean' && gov && gov.font_source_available !== f.evidence.font_source_available) {
                        pass = false;
                        notes.push(`font_source_available not propagated to governance for ${f.fix_id}`);
                    }
                }
            }

            // Overclaim regression
            if (scenario.name.startsWith('REGRESSION: standards overclaim')) {
                const sc = audit.standards_certification_governance || {};
                if (sc.pdfx_compliance_claimed || sc.pdfa_compliance_claimed || sc.compliance_claim_allowed || trust.standard_certified || trust.production_certified) {
                    pass = false;
                    notes.push('Worker propagated a standards/production overclaim from a font fix');
                }
            }

            // certified.pdf filename trust regression
            if (scenario.name.startsWith('REGRESSION: certified.pdf')) {
                if (trust && (trust.trust_level === 'CERTIFIED' || trust.production_certified === true || trust.standard_certified === true)) {
                    pass = false;
                    notes.push('Worker trusted certified.pdf by filename alone');
                }
                if (trust && trust.review_required !== true) {
                    pass = false;
                    notes.push('certified.pdf artifact bypassed review_required enforcement');
                }
            }

            // No glyph synthesis regression
            if (scenario.name.startsWith('REGRESSION: glyph synthesis')) {
                const flagFix = (scenario.mockEngineResult.skipped_fixes || []).find(f => f.fix_id === 'FLAG_MISSING_GLYPHS_UNFIXABLE');
                if (flagFix && flagFix.evidence && flagFix.evidence.glyph_synthesis_performed === true) {
                    pass = false;
                    notes.push('Engine fixture reported glyph_synthesis_performed=true — worker must never propagate glyph invention claims');
                }
                if (gov && !gov.glyphs_missing_unfixable) {
                    pass = false;
                    notes.push('glyphs_missing_unfixable not set true when FLAG_MISSING_GLYPHS_UNFIXABLE attempted');
                }
            }

            // Destructive outline regression
            if (scenario.name.startsWith('REGRESSION: destructive outline')) {
                if (gov && !gov.review_required_reasons.includes('OUTLINE_TYPE3_FONTS')) {
                    pass = false;
                    notes.push('OUTLINE_TYPE3_FONTS not recorded as a review-required reason');
                }
                if (gov && !gov.type3_fonts_outlined) {
                    pass = false;
                    notes.push('type3_fonts_outlined not set true when OUTLINE_TYPE3_FONTS applied');
                }
            }

            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: result.status,
                font_governance: gov || {},
                artifact_trust: trust || {},
                evidence_present: Object.keys((gov && gov.evidence) || {}).length > 0,
                production_certified: trust ? trust.production_certified : undefined,
                standard_certified: trust ? trust.standard_certified : undefined,
                pdfx_compliance_claimed: trust ? trust.pdfx_compliance_claimed : undefined,
                review_required: trust ? trust.review_required : undefined,
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

    const reportJsonPath = path.join(REPORTS_DIR, 'phase66b_worker_font_policy.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase66b_worker_font_policy.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '66B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        input_mode: inputMode,
        results
    }, { spaces: 2 });

    let md = `# Phase 66B — Worker Font Governance Policy\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\nValidates that font_governance, evidence (APPLIED/SKIPPED/FAILED), and artifact_trust remain conservative and intact when Worker policy ingests Engine 66A font fix scenarios (EMBED_FONTS, SUBSET_EMBEDDED_FONTS, OUTLINE_TYPE3_FONTS, REPAIR_FONT_ENCODING, FLAG_MISSING_GLYPHS_UNFIXABLE), that destructive/outline operations are marked review-required, that fonts_embedded/font_embedding_skipped/type3_fonts_detected/glyphs_missing_unfixable/font_source_available evidence fields are preserved, that certified.pdf is never trusted by filename, that no standards/production overclaims leak through, and that glyph synthesis is never reported as performed for unfixable missing glyphs.\n\n`;
    md += `## Results\n\n`;
    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Review Required:** ${res.review_required}\n`;
        md += `- **Production Certified:** ${res.production_certified}\n`;
        md += `- **Standard Certified:** ${res.standard_certified}\n`;
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
