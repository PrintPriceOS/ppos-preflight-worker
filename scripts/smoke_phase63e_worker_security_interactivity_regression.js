'use strict';
/**
 * Phase 63E.2 Smoke Test — Worker PDF Security/Interactivity End-to-End Regression
 *
 * Consumes the Engine 63E.1 report (fallback to SYNTHETIC_POLICY_FALLBACK) and
 * re-validates that AutofixProcessor preserves security_interactivity_governance
 * (in fix_audit and delta_report) and artifact_trust end-to-end, using the same
 * harness wiring as Phase 63B.
 */

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
const ENGINE_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase63e_engine_security_interactivity_regression.json');

// Map an Engine 63E.1 regression result entry into a synthetic Engine autofixPdf-shaped payload.
function toMockEngineResult(engineResult) {
    const fixEntry = {
        fix_id: engineResult.capability,
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

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    let engineScenarios = [];

    if (await fs.pathExists(ENGINE_REPORT_PATH)) {
        const engineReport = await fs.readJson(ENGINE_REPORT_PATH);
        engineScenarios = (engineReport.results || [])
            .filter(r => !r.scenario.includes('(aggregate)'))
            .map(r => ({
                name: r.scenario,
                mockEngineResult: toMockEngineResult(r)
            }));
        inputMode = 'ENGINE_REPORT';
        console.log(`[TEST] Loaded ${engineScenarios.length} scenarios from Engine report (63E.1).`);
    } else {
        console.log('[TEST] Engine 63E.1 report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
        engineScenarios = [
            { name: 'SYNTHETIC: STRIP_JAVASCRIPT removed', mockEngineResult: { applied_fixes: [{ fix_id: 'STRIP_JAVASCRIPT', status: 'APPLIED', evidence: { objects_scanned: 4, javascript_removed_count: 1, output_pdf_valid: true } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: REMOVE_LAUNCH_ACTIONS removed', mockEngineResult: { applied_fixes: [{ fix_id: 'REMOVE_LAUNCH_ACTIONS', status: 'APPLIED', evidence: { launch_actions_removed_count: 1, output_pdf_valid: true } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: REMOVE_EMBEDDED_FILES removed', mockEngineResult: { applied_fixes: [{ fix_id: 'REMOVE_EMBEDDED_FILES', status: 'APPLIED', evidence: { embedded_files_removed_count: 1, output_pdf_valid: true } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: REMOVE_DOCUMENT_OPEN_ACTIONS removed', mockEngineResult: { applied_fixes: [{ fix_id: 'REMOVE_DOCUMENT_OPEN_ACTIONS', status: 'APPLIED', evidence: { document_actions_removed_count: 1, output_pdf_valid: true } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: REMOVE_PAGE_OPEN_ACTIONS removed', mockEngineResult: { applied_fixes: [{ fix_id: 'REMOVE_PAGE_OPEN_ACTIONS', status: 'APPLIED', evidence: { page_actions_removed_count: 1, output_pdf_valid: true } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: FLATTEN_ANNOTATIONS applied', mockEngineResult: { applied_fixes: [{ fix_id: 'FLATTEN_ANNOTATIONS', status: 'APPLIED', evidence: { annotations_detected_count: 2, annotations_flattened_count: 2, output_pdf_valid: true } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: FLATTEN_ANNOTATIONS skipped unsupported', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'FLATTEN_ANNOTATIONS', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { annotations_detected_count: 2, annotations_flattened_count: 0 } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: FLATTEN_FORMS applied', mockEngineResult: { applied_fixes: [{ fix_id: 'FLATTEN_FORMS', status: 'APPLIED', evidence: { forms_detected_count: 1, forms_flattened_count: 1, output_pdf_valid: true } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: FLATTEN_FORMS skipped unsupported', mockEngineResult: { applied_fixes: [], skipped_fixes: [{ fix_id: 'FLATTEN_FORMS', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { forms_detected_count: 1, forms_flattened_count: 0 } }], failed_fixes: [] } },
            { name: 'SYNTHETIC: mixed active content (STRIP_JAVASCRIPT + FLATTEN_FORMS)', mockEngineResult: { applied_fixes: [{ fix_id: 'STRIP_JAVASCRIPT', status: 'APPLIED', evidence: { javascript_removed_count: 1 } }, { fix_id: 'FLATTEN_FORMS', status: 'APPLIED', evidence: { forms_flattened_count: 1 } }], skipped_fixes: [], failed_fixes: [] } },
            { name: 'SYNTHETIC: clean control no action', mockEngineResult: { applied_fixes: [], skipped_fixes: [], failed_fixes: [] } }
        ];
    }

    // Extra regression-only scenarios: overclaim / certified.pdf / evidence preservation guards
    engineScenarios.push(
        {
            name: 'REGRESSION: standards overclaim from security/interactivity fix must be rejected',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'STRIP_JAVASCRIPT', status: 'APPLIED', evidence: { javascript_removed_count: 1 } }],
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
                applied_fixes: [{ fix_id: 'FLATTEN_ANNOTATIONS', status: 'APPLIED', evidence: { annotations_flattened_count: 1 } }],
                skipped_fixes: [],
                failed_fixes: [],
                artifacts: { fixed_pdf: { path: 'certified.pdf' } }
            }
        },
        {
            name: 'REGRESSION: evidence preservation across applied/skipped/failed buckets',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'REMOVE_EMBEDDED_FILES', status: 'APPLIED', evidence: { embedded_files_removed_count: 2, output_pdf_valid: true } }],
                skipped_fixes: [{ fix_id: 'FLATTEN_FORMS', status: 'SKIPPED_UNSUPPORTED', reason: 'SKIPPED_UNSUPPORTED', evidence: { forms_detected_count: 1, forms_flattened_count: 0, limitations: ['Appearance preservation could not be verified.'] } }],
                failed_fixes: [{ fix_id: 'REMOVE_LAUNCH_ACTIONS', status: 'FAILED', evidence: { actions_removed_count: 0, warnings: ['Tool error while parsing actions.'] } }]
            }
        }
    );

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase63e-worker-test-${Date.now()}`);
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
                jobId: 'job-63e',
                tenantId: 'tenant-63e',
                input: { fileUrl: mockInput, findings: [{ id: 'PDF_SECURITY_CLEANUP_REQUIRED' }] },
                fixes: ['STRIP_JAVASCRIPT']
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

            const gov = audit.security_interactivity_governance;
            const trust = audit.artifact_trust;

            if (!gov) { pass = false; notes.push('security_interactivity_governance missing in fix_audit.json'); }
            if (!delta.security_interactivity_governance) { pass = false; notes.push('security_interactivity_governance missing in delta_report.json'); }

            const allFixes = [
                ...(scenario.mockEngineResult.applied_fixes || []),
                ...(scenario.mockEngineResult.skipped_fixes || []),
                ...(scenario.mockEngineResult.failed_fixes || [])
            ];
            const hasApplied = allFixes.some(f => f.status === 'APPLIED');

            if (gov && hasApplied) {
                if (!gov.review_required) { pass = false; notes.push('Review not required when security/interactivity fix applied'); }
                if (gov.production_certified) { pass = false; notes.push('Governance leaked production_certified=true'); }
                if (gov.standard_certified) { pass = false; notes.push('Governance leaked standard_certified=true'); }
                if (gov.compliance_claim_allowed) { pass = false; notes.push('Governance leaked compliance_claim_allowed=true'); }
                if (!trust || trust.review_required !== true) { pass = false; notes.push('artifact_trust.review_required not forced true'); }
                if (!trust || trust.trust_level !== 'FIXED_REVIEW_REQUIRED') { pass = false; notes.push('artifact_trust.trust_level not FIXED_REVIEW_REQUIRED'); }
                if (trust && trust.certified_pdf_allowed) { pass = false; notes.push('artifact_trust.certified_pdf_allowed leaked true'); }
                if (trust && Array.isArray(trust.blocked_by_governance_domains) && !trust.blocked_by_governance_domains.includes('security_interactivity')) {
                    pass = false; notes.push('artifact_trust.blocked_by_governance_domains missing security_interactivity');
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

            // Overclaim regression
            if (scenario.name.startsWith('REGRESSION: standards overclaim')) {
                const sc = audit.standards_certification_governance || {};
                if (sc.pdfx_compliance_claimed || sc.pdfa_compliance_claimed || sc.compliance_claim_allowed || trust.standard_certified || trust.production_certified) {
                    pass = false;
                    notes.push('Worker propagated a standards/production overclaim from a security/interactivity fix');
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

            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: result.status,
                security_interactivity_governance: gov || {},
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

    const reportJsonPath = path.join(REPORTS_DIR, 'phase63e_worker_security_interactivity_regression.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase63e_worker_security_interactivity_regression.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '63E.2',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        input_mode: inputMode,
        results
    }, { spaces: 2 });

    let md = `# Phase 63E.2 — Worker Security/Interactivity End-to-End Regression\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\nConsumes Engine 63E.1 regression scenarios end-to-end and re-validates that AutofixProcessor preserves security_interactivity_governance (fix_audit + delta_report), per-fix evidence across APPLIED/SKIPPED/FAILED buckets, and artifact_trust (trust_level=FIXED_REVIEW_REQUIRED, review_required forced true, certified_pdf_allowed=false, blocked_by_governance_domains includes security_interactivity), with no standards/production overclaim leakage and no certified.pdf filename trust.\n\n`;
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
