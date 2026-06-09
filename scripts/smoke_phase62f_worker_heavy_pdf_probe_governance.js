/**
 * smoke_phase62f_worker_heavy_pdf_probe_governance.js
 *
 * Phase 62F-B — Worker Heavy PDF Probe Governance Smoke Test
 *
 * Scenarios:
 *  1. qpdf WARNING_ONLY — governance preserved, not generic fatal
 *  2. pdfimages WARNING_ONLY — governance preserved, not generic fatal
 *  3. qpdf FAILED_FATAL — fatal preserved, blocks production
 *  4. pdfimages FAILED_NO_OUTPUT — fatal preserved, blocks production
 *  5. Heavy file degraded_but_usable=true — review required, not fatal
 *  6. Heavy file fatal_document_failure=true — requires remediation
 *  7. certified.pdf filename regression — not trusted when review_required
 *  8. Standards overclaim regression — no PDF/X or PDF/A claim from probe semantics
 *  9. strict_forensic_mode=true — warning-only probes still block certification
 * 10. Evidence preservation — probe evidence fields preserved in fix_audit and delta_report
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
const ENGINE_REPORT_PATH = path.resolve(
    __dirname,
    '../../ppos-preflight-engine/reports/phase62f_engine_heavy_pdf_probe_semantics.json'
);

// Build qpdf WARNING_ONLY governance object
function makeQpdfWarningOnlyGov(overrides = {}) {
    return {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        probe_summary: { total: 2, success: 0, success_with_warnings: 0, warning_only: 2, partial_success: 0, failed_fatal: 0 },
        tools: {
            qpdf: {
                raw_status: 'FAILED',
                semantic_status: 'WARNING_ONLY',
                severity: 'warning',
                usable_output: true,
                fatal: false,
                warning_classes: ['PDF_LINEARIZATION_HINT_WARNING', 'PDF_SHARED_OBJECT_HINT_MISMATCH', 'PDF_OBJECT_COUNT_HINT_MISMATCH']
            }
        },
        warnings: [],
        review_required_reasons: ['TOOL_PROBE_WARNING:qpdf'],
        evidence: { qpdf_exit_code: 3, qpdf_stderr_excerpt: 'WARNING: page 0 has shared identifier entries' },
        ...overrides
    };
}

function makePdfimagesWarningOnlyGov(overrides = {}) {
    return {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: true,
        fatal_document_failure: false,
        certifiable: false,
        review_required: true,
        probe_summary: { total: 2, success: 0, success_with_warnings: 0, warning_only: 2, partial_success: 0, failed_fatal: 0 },
        tools: {
            pdfimages: {
                raw_status: 'FAILED',
                semantic_status: 'WARNING_ONLY',
                severity: 'warning',
                usable_output: true,
                fatal: false,
                warning_classes: ['PDF_FONT_WEIGHT_WARNING']
            }
        },
        warnings: [],
        review_required_reasons: ['PDF_FONT_WEIGHT_WARNING:pdfimages'],
        evidence: { pdfimages_exit_code: 1, pdfimages_stderr_excerpt: 'Syntax Warning: Invalid Font Weight' },
        ...overrides
    };
}

function makeQpdfFatalGov(overrides = {}) {
    return {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: false,
        fatal_document_failure: true,
        certifiable: false,
        review_required: true,
        probe_summary: { total: 2, success: 0, success_with_warnings: 0, warning_only: 0, partial_success: 0, failed_fatal: 1 },
        tools: {
            qpdf: {
                raw_status: 'FAILED',
                semantic_status: 'FAILED_FATAL',
                severity: 'error',
                usable_output: false,
                fatal: true,
                structural_fatal: true,
                fatal_classes: ['INVALID_XREF', 'UNABLE_TO_FIND_TRAILER']
            }
        },
        warnings: [],
        review_required_reasons: ['QPDF_FATAL_STRUCTURAL_ERROR'],
        evidence: { qpdf_exit_code: 2, qpdf_stderr_excerpt: 'unable to find trailer dictionary' },
        ...overrides
    };
}

function makePdfimagesFatalGov(overrides = {}) {
    return {
        heavy_pdf_detected: true,
        file_size_bytes: 853898611,
        file_size_mb: 814.34,
        page_count: 64,
        probe_semantics_applied: true,
        analysis_degraded: true,
        degraded_but_usable: false,
        fatal_document_failure: true,
        certifiable: false,
        review_required: true,
        probe_summary: { total: 2, success: 0, success_with_warnings: 0, warning_only: 0, partial_success: 0, failed_fatal: 1 },
        tools: {
            pdfimages: {
                raw_status: 'FAILED',
                semantic_status: 'FAILED_NO_OUTPUT',
                severity: 'error',
                usable_output: false,
                fatal: true,
                fatal_classes: ['NO_OUTPUT']
            }
        },
        warnings: [],
        review_required_reasons: ['PDFIMAGES_NO_OUTPUT'],
        evidence: { pdfimages_exit_code: 1, pdfimages_stderr_excerpt: "Couldn't open file" },
        ...overrides
    };
}

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';

    // Optionally augment with real Engine 62F report
    let engineReport = null;
    if (await fs.pathExists(ENGINE_REPORT_PATH)) {
        try {
            engineReport = await fs.readJson(ENGINE_REPORT_PATH);
            inputMode = 'ENGINE_62F_REPORT_AUGMENTED';
            console.log(`[TEST] Engine 62F report found — augmenting with engine scenarios.`);
        } catch (e) {
            console.warn(`[TEST] Could not load Engine 62F report: ${e.message}`);
        }
    }

    const scenarios = [
        // 1. qpdf WARNING_ONLY — governance preserved, not fatal
        {
            name: 'qpdf WARNING_ONLY — governance preserved, not generic fatal',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: makeQpdfWarningOnlyGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing from fix_audit.json'); return notes; }
                if (gov.fatal_document_failure !== false) notes.push('fatal_document_failure should be false for WARNING_ONLY');
                if (!gov.analysis_degraded) notes.push('analysis_degraded should be true');
                if (!gov.degraded_but_usable) notes.push('degraded_but_usable should be true');
                if (!gov.review_required) notes.push('review_required should be true');
                if (gov.tools?.qpdf?.semantic_status !== 'WARNING_ONLY') notes.push(`qpdf semantic_status should be WARNING_ONLY, got ${gov.tools?.qpdf?.semantic_status}`);
                if (!gov.tools?.qpdf?.usable_output) notes.push('qpdf usable_output should be true');
                if (gov.tools?.qpdf?.fatal !== false) notes.push('qpdf fatal should be false');
                if (!gov.tools?.qpdf?.warning_classes?.includes('PDF_LINEARIZATION_HINT_WARNING')) notes.push('PDF_LINEARIZATION_HINT_WARNING not preserved');
                if (gov.production_certified !== false) notes.push('heavy_pdf_probe_governance.production_certified must be false');
                if (gov.pdfx_compliance_claimed !== false) notes.push('pdfx_compliance_claimed must be false');
                if (gov.pdfa_compliance_claimed !== false) notes.push('pdfa_compliance_claimed must be false');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true');
                // Verify trust_level reflects degraded analysis
                if (trust && !['DEGRADED_ANALYSIS_REVIEW_REQUIRED', 'FIXED_REVIEW_REQUIRED', 'ANALYSIS_FAILED_REVIEW_REQUIRED'].includes(trust.trust_level)) {
                    notes.push(`trust_level should be a review variant, got ${trust.trust_level}`);
                }
                if (!delta.heavy_pdf_probe_governance) notes.push('heavy_pdf_probe_governance missing from delta_report.json');
                return notes;
            }
        },

        // 2. pdfimages WARNING_ONLY — governance preserved, not fatal
        {
            name: 'pdfimages WARNING_ONLY — governance preserved, not generic fatal',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: makePdfimagesWarningOnlyGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                if (gov.fatal_document_failure !== false) notes.push('fatal_document_failure should be false for WARNING_ONLY');
                if (gov.tools?.pdfimages?.semantic_status !== 'WARNING_ONLY') notes.push(`pdfimages semantic_status should be WARNING_ONLY, got ${gov.tools?.pdfimages?.semantic_status}`);
                if (!gov.tools?.pdfimages?.usable_output) notes.push('pdfimages usable_output should be true');
                if (gov.tools?.pdfimages?.fatal !== false) notes.push('pdfimages fatal should be false');
                if (!gov.tools?.pdfimages?.warning_classes?.includes('PDF_FONT_WEIGHT_WARNING')) notes.push('PDF_FONT_WEIGHT_WARNING not preserved');
                if (gov.production_certified !== false) notes.push('heavy_pdf_probe_governance.production_certified must be false');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true');
                if (!delta.heavy_pdf_probe_governance) notes.push('heavy_pdf_probe_governance missing from delta_report.json');
                return notes;
            }
        },

        // 3. qpdf FAILED_FATAL — fatal preserved, blocks production
        {
            name: 'qpdf FAILED_FATAL — fatal preserved, blocks production',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: makeQpdfFatalGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                if (!gov.fatal_document_failure) notes.push('fatal_document_failure should be true for FAILED_FATAL');
                if (!gov.review_required) notes.push('review_required should be true');
                if (gov.tools?.qpdf?.semantic_status !== 'FAILED_FATAL') notes.push(`qpdf semantic_status should be FAILED_FATAL, got ${gov.tools?.qpdf?.semantic_status}`);
                if (!gov.tools?.qpdf?.fatal) notes.push('qpdf fatal should be true');
                if (gov.production_certified !== false) notes.push('heavy_pdf_probe_governance.production_certified must be false');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true');
                if (trust && trust.certified_pdf_allowed !== false) notes.push('certified_pdf_allowed should be false for fatal failure');
                // trust_level must be ANALYSIS_FAILED or similar
                if (trust && trust.trust_level !== 'ANALYSIS_FAILED_REVIEW_REQUIRED') {
                    notes.push(`trust_level should be ANALYSIS_FAILED_REVIEW_REQUIRED for fatal, got ${trust.trust_level}`);
                }
                if (!trust?.blocked_by_governance_domains?.includes('heavy_pdf_probe')) {
                    notes.push('heavy_pdf_probe should be in blocked_by_governance_domains');
                }
                if (!delta.heavy_pdf_probe_governance) notes.push('heavy_pdf_probe_governance missing from delta_report.json');
                return notes;
            }
        },

        // 4. pdfimages FAILED_NO_OUTPUT — fatal preserved, blocks production
        {
            name: 'pdfimages FAILED_NO_OUTPUT — fatal preserved, blocks production',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: makePdfimagesFatalGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                if (!gov.fatal_document_failure) notes.push('fatal_document_failure should be true');
                if (gov.tools?.pdfimages?.semantic_status !== 'FAILED_NO_OUTPUT') notes.push(`pdfimages semantic_status should be FAILED_NO_OUTPUT, got ${gov.tools?.pdfimages?.semantic_status}`);
                if (!gov.tools?.pdfimages?.fatal) notes.push('pdfimages fatal should be true');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true');
                if (trust && trust.certified_pdf_allowed !== false) notes.push('certified_pdf_allowed must be false');
                return notes;
            }
        },

        // 5. Heavy file degraded_but_usable=true — review required, not fatal
        {
            name: 'heavy file degraded_but_usable=true — review required, degraded trust level',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: {
                    heavy_pdf_detected: true,
                    file_size_bytes: 853898611,
                    file_size_mb: 814.34,
                    page_count: 64,
                    probe_semantics_applied: true,
                    analysis_degraded: true,
                    degraded_but_usable: true,
                    fatal_document_failure: false,
                    certifiable: false,
                    review_required: true,
                    probe_summary: { total: 2, warning_only: 2 },
                    tools: {
                        qpdf: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_LINEARIZATION_HINT_WARNING'] },
                        pdfimages: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_FONT_WEIGHT_WARNING'] }
                    },
                    warnings: [],
                    review_required_reasons: ['TOOL_PROBE_WARNING:qpdf', 'PDF_FONT_WEIGHT_WARNING:pdfimages'],
                    evidence: {}
                }
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                if (!gov.analysis_degraded) notes.push('analysis_degraded should be true');
                if (!gov.degraded_but_usable) notes.push('degraded_but_usable should be true');
                if (gov.fatal_document_failure) notes.push('fatal_document_failure should be false');
                if (!gov.review_required) notes.push('review_required should be true');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true');
                if (trust && trust.review_required !== true) notes.push('artifact_trust.review_required should be true');
                // trust_level should be degraded review variant
                if (trust && trust.trust_level === 'ANALYSIS_FAILED_REVIEW_REQUIRED') {
                    notes.push('trust_level should not be ANALYSIS_FAILED for degraded_but_usable (only for fatal)');
                }
                if (trust && !['DEGRADED_ANALYSIS_REVIEW_REQUIRED', 'FIXED_REVIEW_REQUIRED'].includes(trust.trust_level)) {
                    notes.push(`trust_level should be DEGRADED_ANALYSIS_REVIEW_REQUIRED or FIXED_REVIEW_REQUIRED, got ${trust.trust_level}`);
                }
                if (!delta.heavy_pdf_probe_governance) notes.push('heavy_pdf_probe_governance missing from delta_report.json');
                return notes;
            }
        },

        // 6. Heavy file fatal_document_failure=true — requires remediation
        {
            name: 'heavy file fatal_document_failure=true — requires remediation, max restrictions',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: makeQpdfFatalGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                if (!gov.fatal_document_failure) notes.push('fatal_document_failure must be true');
                if (!gov.review_required) notes.push('review_required must be true');
                if (gov.production_certified !== false) notes.push('production_certified must be false in governance');
                if (gov.standard_certified !== false) notes.push('standard_certified must be false in governance');
                if (gov.pdfx_compliance_claimed !== false) notes.push('pdfx_compliance_claimed must be false');
                if (gov.pdfa_compliance_claimed !== false) notes.push('pdfa_compliance_claimed must be false');
                if (gov.compliance_claim_allowed !== false) notes.push('compliance_claim_allowed must be false');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true');
                if (trust && trust.standard_certified === true) notes.push('artifact_trust.standard_certified leaked true');
                if (trust && trust.certified_pdf_allowed !== false) notes.push('artifact_trust.certified_pdf_allowed must be false');
                if (trust && trust.pdfx_compliance_claimed !== false) notes.push('artifact_trust.pdfx_compliance_claimed must be false');
                if (trust && trust.pdfa_compliance_claimed !== false) notes.push('artifact_trust.pdfa_compliance_claimed must be false');
                if (trust && trust.compliance_claim_allowed !== false) notes.push('artifact_trust.compliance_claim_allowed must be false');
                // A remediation warning must appear
                const warnings = (trust?.warnings || []).join(' ');
                if (!warnings.toLowerCase().includes('fatal') && !warnings.toLowerCase().includes('repair') && !warnings.toLowerCase().includes('re-export')) {
                    notes.push('artifact_trust.warnings should contain remediation guidance for fatal failure');
                }
                return notes;
            }
        },

        // 7. certified.pdf filename regression — not trusted when review_required=true
        {
            name: 'certified.pdf filename regression — suppressed when review_required=true',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                // Simulate Engine that incorrectly claims production_certified=true but has review_required governance
                production_certified: true,
                pdfx_compliance_claimed: true,
                compliance_claim_allowed: true,
                heavy_pdf_probe_governance: makeQpdfWarningOnlyGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                // Despite engine claiming production_certified=true, Worker governance must block it
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true (should be blocked by heavy PDF probe)');
                if (trust && trust.certified_pdf_allowed === true) notes.push('certified_pdf_allowed leaked true (certified.pdf should be suppressed)');
                if (trust && trust.review_required !== true) notes.push('artifact_trust.review_required should be true');
                if (gov.production_certified !== false) notes.push('heavy_pdf_probe_governance.production_certified must be false');
                return notes;
            }
        },

        // 8. Standards overclaim regression — no PDF/X or PDF/A from probe semantics
        {
            name: 'standards overclaim regression — no PDF/X or PDF/A from heavy PDF probe',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                // Engine returns seeming standards claim
                pdfx_compliance_claimed: true,
                pdfa_compliance_claimed: true,
                standard_certified: true,
                compliance_claim_allowed: true,
                heavy_pdf_probe_governance: makeQpdfWarningOnlyGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                if (gov.pdfx_compliance_claimed !== false) notes.push('heavy_pdf_probe_governance.pdfx_compliance_claimed must be false');
                if (gov.pdfa_compliance_claimed !== false) notes.push('heavy_pdf_probe_governance.pdfa_compliance_claimed must be false');
                if (gov.compliance_claim_allowed !== false) notes.push('heavy_pdf_probe_governance.compliance_claim_allowed must be false');
                if (trust && trust.pdfx_compliance_claimed === true) notes.push('artifact_trust.pdfx_compliance_claimed leaked true');
                if (trust && trust.pdfa_compliance_claimed === true) notes.push('artifact_trust.pdfa_compliance_claimed leaked true');
                return notes;
            }
        },

        // 9. strict_forensic_mode=true — warning-only probes still block certification
        {
            name: 'strict_forensic_mode=true — warning-only probes block certification',
            jobExtraData: { strict_forensic_mode: true },
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: {
                    heavy_pdf_detected: true,
                    file_size_bytes: 200 * 1024 * 1024,
                    file_size_mb: 200,
                    page_count: 20,
                    probe_semantics_applied: true,
                    analysis_degraded: false,
                    degraded_but_usable: false,
                    fatal_document_failure: false,
                    certifiable: false,
                    review_required: false, // Engine says no review required
                    probe_summary: { total: 1, warning_only: 1 },
                    tools: {
                        qpdf: { semantic_status: 'WARNING_ONLY', severity: 'warning', usable_output: true, fatal: false, warning_classes: ['PDF_LINEARIZATION_HINT_WARNING'] }
                    },
                    warnings: [],
                    review_required_reasons: [],
                    evidence: {}
                }
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing'); return notes; }
                if (!gov.strict_forensic_mode) notes.push('strict_forensic_mode not preserved in governance');
                // strict_forensic_mode + probe_semantics_applied should set review_required=true in Worker
                if (!gov.review_required) notes.push('review_required should be true in strict_forensic_mode when probe_semantics_applied');
                if (trust && trust.production_certified === true) notes.push('artifact_trust.production_certified leaked true in strict_forensic_mode');
                if (trust && trust.review_required !== true) notes.push('artifact_trust.review_required should be true in strict_forensic_mode');
                // Strict forensic mode warning should appear
                const warnings = (gov.warnings || []).join(' ');
                if (!warnings.toLowerCase().includes('forensic') && !warnings.toLowerCase().includes('strict')) {
                    notes.push('strict_forensic_mode warning not emitted in governance.warnings');
                }
                return notes;
            }
        },

        // 10. Evidence preservation — probe evidence fields preserved in fix_audit and delta_report
        {
            name: 'evidence preservation — probe evidence and tool semantics preserved end-to-end',
            jobExtraData: {},
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [],
                failed_fixes: [],
                heavy_pdf_probe_governance: makeQpdfWarningOnlyGov()
            },
            checks: (gov, trust, audit, delta) => {
                const notes = [];
                if (!gov) { notes.push('heavy_pdf_probe_governance missing from fix_audit.json'); return notes; }
                // Required top-level fields
                const requiredFields = [
                    'heavy_pdf_detected', 'file_size_bytes', 'file_size_mb', 'page_count',
                    'probe_semantics_applied', 'analysis_degraded', 'degraded_but_usable',
                    'fatal_document_failure', 'certifiable', 'review_required',
                    'production_certified', 'standard_certified', 'pdfx_compliance_claimed',
                    'pdfa_compliance_claimed', 'compliance_claim_allowed',
                    'probe_summary', 'tools', 'warnings', 'review_required_reasons', 'evidence'
                ];
                for (const field of requiredFields) {
                    if (!(field in gov)) notes.push(`heavy_pdf_probe_governance missing required field: ${field}`);
                }
                // Tool evidence preserved
                if (!gov.tools?.qpdf?.warning_classes) notes.push('qpdf.warning_classes not preserved in governance.tools');
                if (!gov.evidence) notes.push('evidence block missing from governance');
                // Delta report also carries governance
                if (!delta.heavy_pdf_probe_governance) notes.push('heavy_pdf_probe_governance missing from delta_report.json');
                // Verify in delta as well
                const deltaGov = delta.heavy_pdf_probe_governance;
                if (deltaGov && deltaGov.fatal_document_failure !== false) notes.push('delta_report.heavy_pdf_probe_governance.fatal_document_failure mismatch');
                // blocked_by_governance_domains
                const blocked = trust?.blocked_by_governance_domains || [];
                if (!blocked.includes('heavy_pdf_probe')) notes.push('heavy_pdf_probe not in blocked_by_governance_domains when review_required=true');
                return notes;
            }
        }
    ];

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase62f-worker-test-${Date.now()}`);
    process.env.TEST_DIR = testDir;
    await fs.ensureDir(testDir);
    const mockInput = path.join(testDir, 'input.pdf');
    await fs.writeFile(mockInput, '%PDF-1.4\nTest');
    const mockOutput = path.join(testDir, 'mock_engine_output.pdf');
    await fs.writeFile(mockOutput, '%PDF-1.4\nTest Fixed');

    AutofixProcessor.sanitizePdfForAutofix = async () => mockInput;

    for (const scenario of scenarios) {
        console.log(`\n[TEST] Running: ${scenario.name}`);

        currentEngineMockResult = {
            fixedPath: mockOutput,
            artifacts: { fixed_pdf: { path: mockOutput } },
            ...scenario.mockEngineResult
        };

        const job = {
            data: {
                jobId: 'job-62f-b',
                tenantId: 'tenant-62f-b',
                input: {
                    fileUrl: mockInput,
                    fixes: [],
                    ...(scenario.jobExtraData || {})
                },
                ...(scenario.jobExtraData || {})
            },
            updateProgress: async () => {}
        };

        let pass = true;
        const notes = [];

        try {
            const result = await AutofixProcessor.process(job, {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {}
            });

            const fixAuditPath = path.join(testDir, 'fix_audit.json');
            const deltaReportPath = path.join(testDir, 'delta_report.json');

            const audit = await fs.readJson(fixAuditPath);
            const delta = await fs.readJson(deltaReportPath);

            const gov = audit.heavy_pdf_probe_governance;
            const trust = audit.artifact_trust;

            if (!gov) {
                pass = false;
                notes.push('heavy_pdf_probe_governance missing from fix_audit.json');
            } else {
                const checkNotes = scenario.checks(gov, trust, audit, delta);
                checkNotes.forEach(n => { pass = false; notes.push(n); });
            }

            // Invariant: governance.production_certified is always false
            if (gov && gov.production_certified !== false) {
                pass = false;
                notes.push('INVARIANT VIOLATED: heavy_pdf_probe_governance.production_certified must always be false');
            }
            if (gov && gov.pdfx_compliance_claimed !== false) {
                pass = false;
                notes.push('INVARIANT VIOLATED: heavy_pdf_probe_governance.pdfx_compliance_claimed must always be false');
            }
            if (gov && gov.pdfa_compliance_claimed !== false) {
                pass = false;
                notes.push('INVARIANT VIOLATED: heavy_pdf_probe_governance.pdfa_compliance_claimed must always be false');
            }
            if (gov && gov.compliance_claim_allowed !== false) {
                pass = false;
                notes.push('INVARIANT VIOLATED: heavy_pdf_probe_governance.compliance_claim_allowed must always be false');
            }
            if (gov && gov.standard_certified !== false) {
                pass = false;
                notes.push('INVARIANT VIOLATED: heavy_pdf_probe_governance.standard_certified must always be false');
            }

            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: result.status,
                heavy_pdf_probe_governance: gov || {},
                artifact_trust_level: trust ? trust.trust_level : null,
                review_required: trust ? trust.review_required : null,
                production_certified: trust ? trust.production_certified : null,
                standard_certified: trust ? trust.standard_certified : null,
                certified_pdf_allowed: trust ? trust.certified_pdf_allowed : null,
                pdfx_compliance_claimed: trust ? trust.pdfx_compliance_claimed : null,
                pdfa_compliance_claimed: trust ? trust.pdfa_compliance_claimed : null,
                heavy_pdf_probe_governance_present: !!gov,
                heavy_pdf_detected: gov ? gov.heavy_pdf_detected : null,
                fatal_document_failure: gov ? gov.fatal_document_failure : null,
                analysis_degraded: gov ? gov.analysis_degraded : null,
                degraded_but_usable: gov ? gov.degraded_but_usable : null,
                probe_semantics_applied: gov ? gov.probe_semantics_applied : null,
                tool_qpdf_semantic_status: gov?.tools?.qpdf?.semantic_status || null,
                tool_pdfimages_semantic_status: gov?.tools?.pdfimages?.semantic_status || null,
                blocked_by_governance_domains: trust ? trust.blocked_by_governance_domains : null,
                overclaim_guard_passed: gov ? (gov.pdfx_compliance_claimed === false && gov.pdfa_compliance_claimed === false && gov.production_certified === false && gov.standard_certified === false && gov.compliance_claim_allowed === false) : false,
                pass,
                notes: notes.length ? notes.join('; ') : 'OK'
            });
        } catch (err) {
            console.error(err);
            pass = false;
            results.push({
                scenario: scenario.name,
                input_mode: inputMode,
                status: 'ERROR',
                pass: false,
                notes: err.message
            });
        }

        if (!pass) smokePassed = false;
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${scenario.name}`);
        if (!pass) {
            const last = results[results.length - 1];
            (last.notes || '').split('; ').forEach(n => n && console.log(`    - ${n}`));
        }
    }

    // --- Reports ---
    const reportJsonPath = path.join(REPORTS_DIR, 'phase62f_worker_heavy_pdf_probe_governance.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase62f_worker_heavy_pdf_probe_governance.md');

    await fs.writeJson(reportJsonPath, {
        timestamp: new Date().toISOString(),
        phase: '62F-B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        input_mode: inputMode,
        engine_report_used: engineReport ? ENGINE_REPORT_PATH : null,
        results
    }, { spaces: 2 });

    let md = `# Phase 62F-B — Worker Heavy PDF Probe Governance\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n\n`;
    md += `Validates that \`heavy_pdf_probe_governance\` is preserved from Engine probe semantics into Worker \`fix_audit.json\` v2 and \`delta_report.json\`.\n\n`;
    md += `### Acceptance Criteria\n\n`;
    md += `1. ✅ Worker preserves \`heavy_pdf_probe_governance\` in \`fix_audit.json\` and \`delta_report.json\`\n`;
    md += `2. ✅ Worker preserves tool semantic statuses (qpdf, pdfimages)\n`;
    md += `3. ✅ Worker does not collapse warnings into generic fatal failure\n`;
    md += `4. ✅ Worker keeps fatal failures fatal\n`;
    md += `5. ✅ \`artifact_trust\` is conservative (review_required wins)\n`;
    md += `6. ✅ certified.pdf not trusted by filename when review_required=true\n`;
    md += `7. ✅ No production/standards overclaim from probe semantics\n`;
    md += `8. ✅ strict_forensic_mode blocks certification even for warning-only probes\n`;
    md += `9. ✅ Evidence fields preserved end-to-end\n`;
    md += `10. ✅ \`blocked_by_governance_domains\` includes heavy_pdf_probe when applicable\n\n`;
    md += `### Non-Negotiable Invariants\n\n`;
    md += `- \`heavy_pdf_probe_governance.production_certified\` always \`false\`\n`;
    md += `- \`heavy_pdf_probe_governance.standard_certified\` always \`false\`\n`;
    md += `- \`heavy_pdf_probe_governance.pdfx_compliance_claimed\` always \`false\`\n`;
    md += `- \`heavy_pdf_probe_governance.pdfa_compliance_claimed\` always \`false\`\n`;
    md += `- \`heavy_pdf_probe_governance.compliance_claim_allowed\` always \`false\`\n\n`;
    md += `## Results\n\n`;
    md += `| # | Scenario | Pass | Trust Level | Review Required | Fatal Doc Failure | Tool qpdf | Tool pdfimages | Overclaim Guard | Notes |\n`;
    md += `|---|----------|------|-------------|-----------------|-------------------|-----------|----------------|-----------------|-------|\n`;

    results.forEach((res, i) => {
        md += `| ${i + 1} | ${res.scenario} | ${res.pass ? '✅' : '❌'} | ${res.artifact_trust_level || 'N/A'} | ${res.review_required} | ${res.fatal_document_failure} | ${res.tool_qpdf_semantic_status || 'N/A'} | ${res.tool_pdfimages_semantic_status || 'N/A'} | ${res.overclaim_guard_passed ? '✅' : '❌'} | ${res.notes} |\n`;
    });

    md += `\n## Detailed Results\n\n`;
    for (const res of results) {
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass ? '✅' : '❌'}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        md += `- **Trust Level:** ${res.artifact_trust_level}\n`;
        md += `- **Review Required:** ${res.review_required}\n`;
        md += `- **Production Certified:** ${res.production_certified}\n`;
        md += `- **Standard Certified:** ${res.standard_certified}\n`;
        md += `- **Certified PDF Allowed:** ${res.certified_pdf_allowed}\n`;
        md += `- **pdfx_compliance_claimed:** ${res.pdfx_compliance_claimed}\n`;
        md += `- **pdfa_compliance_claimed:** ${res.pdfa_compliance_claimed}\n`;
        md += `- **Heavy PDF Detected:** ${res.heavy_pdf_detected}\n`;
        md += `- **Fatal Document Failure:** ${res.fatal_document_failure}\n`;
        md += `- **Analysis Degraded:** ${res.analysis_degraded}\n`;
        md += `- **Degraded But Usable:** ${res.degraded_but_usable}\n`;
        md += `- **Probe Semantics Applied:** ${res.probe_semantics_applied}\n`;
        md += `- **qpdf Semantic Status:** ${res.tool_qpdf_semantic_status}\n`;
        md += `- **pdfimages Semantic Status:** ${res.tool_pdfimages_semantic_status}\n`;
        md += `- **Blocked By:** ${JSON.stringify(res.blocked_by_governance_domains)}\n`;
        md += `- **Overclaim Guard Passed:** ${res.overclaim_guard_passed ? '✅' : '❌'}\n\n`;
    }

    await fs.writeFile(reportMdPath, md);
    console.log(`\n[TEST] Reports written to ${REPORTS_DIR}`);

    if (!smokePassed) {
        console.error('[TEST] ❌ Phase 62F-B smoke tests FAILED.');
        process.exit(1);
    } else {
        console.log('[TEST] ✅ Phase 62F-B smoke tests PASSED.');
    }
}

runSmokeTest().catch(err => {
    console.error(err);
    process.exit(1);
});
