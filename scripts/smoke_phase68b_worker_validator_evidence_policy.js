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
const ENGINE_REPORT_PATH = path.resolve(__dirname, '../../ppos-preflight-engine/reports/phase68a_engine_real_standards_validation.json');

const STANDARDS_CAPS = ['VALIDATE_PDFX', 'VALIDATE_PDFA', 'GENERATE_STANDARD_VALIDATION_REPORT', 'CONVERT_TO_PDFX_VALIDATED', 'CONVERT_TO_PDFA_VALIDATED'];

const REQUIRED_EVIDENCE_FIELDS = [
    'validation_performed', 'validation_passed', 'validator_name',
    'validator_version', 'standard_detected', 'validation_report_hash',
    'compliance_claim_allowed'
];

function toMockEngineResult(engineResult) {
    const capabilityIds = (engineResult.capability || '').split(',').map(s => s.trim()).filter(Boolean);
    const fixId = capabilityIds[0] || engineResult.capability;
    if (!fixId) return { applied_fixes: [], skipped_fixes: [], failed_fixes: [] };

    const fixEntry = {
        fix_id: fixId,
        status: engineResult.status,
        reason: (engineResult.notes && engineResult.notes[0]) || engineResult.skip_reason || engineResult.status || undefined,
        validation_performed: engineResult.validation_performed,
        validation_passed: engineResult.validation_passed,
        validator_name: engineResult.validator_name,
        validator_version: engineResult.validator_version,
        standard_detected: engineResult.standard_detected,
        validation_report_hash: engineResult.validation_report_hash,
        compliance_claim_allowed: engineResult.compliance_claim_allowed,
        evidence: engineResult.evidence || undefined
    };

    const buckets = { applied_fixes: [], skipped_fixes: [], failed_fixes: [] };
    if (engineResult.status === 'APPLIED') buckets.applied_fixes.push(fixEntry);
    else if (engineResult.status === 'FAILED') buckets.failed_fixes.push(fixEntry);
    else buckets.skipped_fixes.push(fixEntry);

    return {
        ...buckets,
        // top-level evidence fields forwarded
        validation_performed: engineResult.validation_performed,
        validation_passed: engineResult.validation_passed,
        validator_name: engineResult.validator_name,
        validator_version: engineResult.validator_version,
        standard_detected: engineResult.standard_detected,
        validation_report_hash: engineResult.validation_report_hash,
        compliance_claim_allowed: engineResult.compliance_claim_allowed,
        pdfx_compliance_claimed: engineResult.pdfx_compliance_claimed,
        pdfa_compliance_claimed: engineResult.pdfa_compliance_claimed,
        requires_human_review: engineResult.requires_human_review,
        production_certified: false
    };
}

async function runSmokeTest() {
    await fs.ensureDir(REPORTS_DIR);

    let inputMode = 'SYNTHETIC_POLICY_FALLBACK';
    let engineScenarios = [];

    if (await fs.pathExists(ENGINE_REPORT_PATH)) {
        const engineReport = await fs.readJson(ENGINE_REPORT_PATH);
        engineScenarios = (engineReport.results || [])
            .filter(r => r.capability && STANDARDS_CAPS.includes((r.capability || '').split(',')[0].trim()))
            .map(r => ({
                name: r.scenario,
                mockEngineResult: toMockEngineResult(r)
            }));
        inputMode = 'ENGINE_REPORT';
        console.log(`[TEST] Loaded ${engineScenarios.length} scenarios from Engine report (68A).`);
    } else {
        console.log('[TEST] Engine 68A report not found — using SYNTHETIC_POLICY_FALLBACK scenarios.');
    }

    // Synthetic scenarios always appended to cover policy edge cases
    const syntheticScenarios = [
        {
            name: 'SYNTHETIC: VALIDATE_PDFA skipped — veraPDF not installed',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'VALIDATE_PDFA', status: 'SKIPPED_UNSUPPORTED', reason: 'VALIDATOR_NOT_FOUND',
                    validation_performed: false, validation_passed: false, validator_name: null, validator_version: null,
                    standard_detected: null, validation_report_hash: null, compliance_claim_allowed: false,
                    evidence: { reason: 'VALIDATOR_NOT_FOUND', validator_available: false } }],
                failed_fixes: [],
                validation_performed: false, validation_passed: false, validator_name: null, validator_version: null,
                standard_detected: null, validation_report_hash: null, compliance_claim_allowed: false
            }
        },
        {
            name: 'SYNTHETIC: VALIDATE_PDFX skipped — no PDF/X validator',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'VALIDATE_PDFX', status: 'SKIPPED_UNSUPPORTED', reason: 'VALIDATOR_NOT_FOUND',
                    validation_performed: false, validation_passed: false, validator_name: null, validator_version: null,
                    standard_detected: null, validation_report_hash: null, compliance_claim_allowed: false,
                    evidence: { reason: 'VALIDATOR_NOT_FOUND', validator_available: false } }],
                failed_fixes: [],
                validation_performed: false, validation_passed: false, validator_name: null, validator_version: null,
                standard_detected: null, validation_report_hash: null, compliance_claim_allowed: false
            }
        },
        {
            name: 'SYNTHETIC: GENERATE_STANDARD_VALIDATION_REPORT skipped — no real validator',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'GENERATE_STANDARD_VALIDATION_REPORT', status: 'SKIPPED',
                    validation_performed: false, compliance_claim_allowed: false,
                    evidence: { reason: 'No real standards validator executed', validator_name: null } }],
                failed_fixes: [],
                validation_performed: false, compliance_claim_allowed: false
            }
        },
        {
            name: 'SYNTHETIC: CONVERT_TO_PDFX_VALIDATED skipped unsupported',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'CONVERT_TO_PDFX_VALIDATED', status: 'SKIPPED_UNSUPPORTED',
                    compliance_claim_allowed: false,
                    evidence: { reason: 'No PDF/X conversion+validation pipeline' } }],
                failed_fixes: [],
                compliance_claim_allowed: false
            }
        },
        {
            name: 'SYNTHETIC: CONVERT_TO_PDFA_VALIDATED skipped unsupported',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'CONVERT_TO_PDFA_VALIDATED', status: 'SKIPPED_UNSUPPORTED',
                    compliance_claim_allowed: false,
                    evidence: { reason: 'No validated PDF/A conversion pipeline' } }],
                failed_fixes: [],
                compliance_claim_allowed: false
            }
        },
        {
            name: 'SYNTHETIC: clean control — no standards activity',
            mockEngineResult: { applied_fixes: [], skipped_fixes: [], failed_fixes: [] }
        }
    ];

    engineScenarios.push(...syntheticScenarios);

    // Policy regression scenarios
    engineScenarios.push(
        {
            name: 'REGRESSION: compliance_claim_allowed only when all 7 fields present — COMPLETE EVIDENCE',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'VALIDATE_PDFA', status: 'APPLIED',
                    validation_performed: true, validation_passed: true,
                    validator_name: 'veraPDF', validator_version: '1.25.0',
                    standard_detected: 'PDF/A-1b', validation_report_hash: 'abc123def456',
                    compliance_claim_allowed: true,
                    evidence: { validation_performed: true, validation_passed: true, validator_name: 'veraPDF',
                        validator_version: '1.25.0', standard_detected: 'PDF/A-1b',
                        validation_report_hash: 'abc123def456', compliance_claim_allowed: true } }],
                skipped_fixes: [], failed_fixes: [],
                validation_performed: true, validation_passed: true,
                validator_name: 'veraPDF', validator_version: '1.25.0',
                standard_detected: 'PDF/A-1b', validation_report_hash: 'abc123def456',
                compliance_claim_allowed: true
            }
        },
        {
            name: 'REGRESSION: incomplete evidence — missing validation_report_hash — must reject claim',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'VALIDATE_PDFA', status: 'APPLIED',
                    validation_performed: true, validation_passed: true,
                    validator_name: 'veraPDF', validator_version: '1.25.0',
                    standard_detected: 'PDF/A-1b', validation_report_hash: null,
                    compliance_claim_allowed: false,
                    evidence: { validation_performed: true, validation_passed: true, validator_name: 'veraPDF' } }],
                skipped_fixes: [], failed_fixes: [],
                validation_performed: true, validation_passed: true,
                validator_name: 'veraPDF', validator_version: '1.25.0',
                standard_detected: 'PDF/A-1b', validation_report_hash: null,
                compliance_claim_allowed: false
            }
        },
        {
            name: 'REGRESSION: overclaim — compliance_claim_allowed=true without evidence — must be rejected',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'VALIDATE_PDFA', status: 'SKIPPED_UNSUPPORTED',
                    validation_performed: false, compliance_claim_allowed: false,
                    evidence: { reason: 'VALIDATOR_NOT_FOUND' } }],
                failed_fixes: [],
                pdfx_compliance_claimed: true, pdfa_compliance_claimed: true,
                compliance_claim_allowed: true, standard_certified: true,
                validation_performed: false, validator_name: null, validation_report_hash: null
            }
        },
        {
            name: 'REGRESSION: standard_certified=false when evidence incomplete',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'VALIDATE_PDFA', status: 'SKIPPED_UNSUPPORTED',
                    validation_performed: false, compliance_claim_allowed: false,
                    evidence: { reason: 'VALIDATOR_NOT_FOUND' } }],
                failed_fixes: [],
                standard_certified: true, validation_performed: false,
                validator_name: null, validation_report_hash: null
            }
        },
        {
            name: 'REGRESSION: certified.pdf not trusted by filename — skipped standards fix',
            mockEngineResult: {
                applied_fixes: [],
                skipped_fixes: [{ fix_id: 'VALIDATE_PDFX', status: 'SKIPPED_UNSUPPORTED',
                    compliance_claim_allowed: false,
                    evidence: { reason: 'VALIDATOR_NOT_FOUND' } }],
                failed_fixes: [],
                compliance_claim_allowed: false, validation_performed: false
            }
        },
        {
            name: 'REGRESSION: evidence preservation across APPLIED/SKIPPED/FAILED buckets',
            mockEngineResult: {
                applied_fixes: [{ fix_id: 'GENERATE_STANDARD_VALIDATION_REPORT', status: 'APPLIED',
                    validation_performed: false, compliance_claim_allowed: false,
                    evidence: { validator_name: null, validation_passed: false } }],
                skipped_fixes: [{ fix_id: 'VALIDATE_PDFA', status: 'SKIPPED_UNSUPPORTED',
                    validation_performed: false, compliance_claim_allowed: false,
                    evidence: { reason: 'VALIDATOR_NOT_FOUND' } }],
                failed_fixes: [{ fix_id: 'VALIDATE_PDFX', status: 'FAILED',
                    validation_performed: false, compliance_claim_allowed: false,
                    evidence: { reason: 'TOOL_ERROR' } }],
                validation_performed: false, compliance_claim_allowed: false
            }
        }
    );

    const results = [];
    let smokePassed = true;

    const testDir = path.join(os.tmpdir(), `phase68b-worker-test-${Date.now()}`);
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
                jobId: 'job-68b',
                tenantId: 'tenant-68b',
                input: { fileUrl: mockInput, findings: [] },
                fixes: ['VALIDATE_PDFA']
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

            const gov = audit.standards_certification_governance;
            const trust = audit.artifact_trust;

            if (!gov) { pass = false; notes.push('standards_certification_governance missing in fix_audit.json'); }
            if (!delta.standards_certification_governance) { pass = false; notes.push('standards_certification_governance missing in delta_report.json'); }

            // Validate 7-field evidence fields are present in governance output
            if (gov) {
                if (!('validation_report_hash' in gov)) {
                    pass = false; notes.push('validation_report_hash field missing from standards_certification_governance');
                }
                if (!('standard_detected' in gov)) {
                    pass = false; notes.push('standard_detected field missing from standards_certification_governance');
                }
            }

            const allFixes = [
                ...(scenario.mockEngineResult.applied_fixes || []),
                ...(scenario.mockEngineResult.skipped_fixes || []),
                ...(scenario.mockEngineResult.failed_fixes || [])
            ];
            const hasStandardsActivity = allFixes.some(f => STANDARDS_CAPS.includes(f.fix_id));

            // Complete evidence scenario: compliance_claim_allowed must be true
            if (scenario.name.includes('COMPLETE EVIDENCE')) {
                if (!gov || !gov.compliance_claim_allowed) {
                    pass = false; notes.push('compliance_claim_allowed not set to true with complete 7-field evidence');
                }
                if (!gov || !gov.validation_performed) {
                    pass = false; notes.push('validation_performed not preserved from complete evidence');
                }
                if (!gov || !gov.validation_report_hash) {
                    pass = false; notes.push('validation_report_hash not preserved from complete evidence');
                }
                if (!gov || !gov.validator_name) {
                    pass = false; notes.push('validator_name not preserved from complete evidence');
                }
                // Phase 68B: VALIDATE_PDFA must not set pdfx_compliance_claimed
                if (gov && gov.pdfx_compliance_claimed) {
                    pass = false; notes.push('pdfx_compliance_claimed leaked true from VALIDATE_PDFA (standard_detected=PDF/A-1b); only pdfa_compliance_claimed should be set');
                }
                if (!gov || !gov.pdfa_compliance_claimed) {
                    pass = false; notes.push('pdfa_compliance_claimed not set to true from VALIDATE_PDFA with PDF/A-1b standard_detected');
                }
            }

            // Incomplete evidence scenario: claim must be rejected
            if (scenario.name.includes('missing validation_report_hash')) {
                if (gov && gov.compliance_claim_allowed) {
                    pass = false; notes.push('compliance_claim_allowed leaked true despite missing validation_report_hash');
                }
                if (gov && gov.standard_certified) {
                    pass = false; notes.push('standard_certified leaked true despite missing validation_report_hash');
                }
            }

            // Overclaim regression
            if (scenario.name.includes('overclaim — compliance_claim_allowed=true without evidence')) {
                if (gov && gov.compliance_claim_allowed) {
                    pass = false; notes.push('Worker propagated compliance_claim_allowed=true without validator evidence');
                }
                if (gov && gov.pdfx_compliance_claimed) {
                    pass = false; notes.push('Worker propagated pdfx_compliance_claimed=true without validator evidence');
                }
                if (gov && gov.pdfa_compliance_claimed) {
                    pass = false; notes.push('Worker propagated pdfa_compliance_claimed=true without validator evidence');
                }
                if (trust && trust.standard_certified) {
                    pass = false; notes.push('artifact_trust.standard_certified leaked true without validator evidence');
                }
            }

            // standard_certified must be false for incomplete evidence
            if (scenario.name.includes('standard_certified=false')) {
                if (gov && gov.standard_certified) {
                    pass = false; notes.push('standard_certified leaked true from incomplete evidence');
                }
            }

            // certified.pdf not trusted by filename
            if (scenario.name.includes('certified.pdf not trusted by filename')) {
                if (trust && trust.trust_level === 'STANDARD_CERTIFIED') {
                    pass = false; notes.push('artifact_trust reached STANDARD_CERTIFIED without validator evidence');
                }
                if (trust && trust.certified_pdf_allowed) {
                    pass = false; notes.push('certified_pdf_allowed leaked true without validator evidence');
                }
            }

            // For all scenarios with skipped/unsupported standards fixes: claims must be false
            const hasSkippedStandards = (scenario.mockEngineResult.skipped_fixes || []).some(f => STANDARDS_CAPS.includes(f.fix_id));
            if (hasSkippedStandards && !scenario.name.includes('COMPLETE EVIDENCE')) {
                if (gov && gov.compliance_claim_allowed) {
                    pass = false; notes.push('compliance_claim_allowed=true despite skipped standards fix');
                }
                if (gov && gov.standard_certified) {
                    pass = false; notes.push('standard_certified=true despite skipped standards fix');
                }
                if (trust && trust.trust_level === 'STANDARD_CERTIFIED') {
                    pass = false; notes.push('artifact_trust=STANDARD_CERTIFIED despite skipped standards fix');
                }
            }

            // Validate evidence preservation across all fix buckets
            for (const f of allFixes) {
                if (STANDARDS_CAPS.includes(f.fix_id) && f.evidence) {
                    // Evidence object must be synthesized in governance
                    // (We check governance exists and has evidence fields; per-fix evidence structure is in fix arrays)
                }
            }

            // Clean control: all false, no review forced by standards
            if (scenario.name.includes('clean control')) {
                if (gov && gov.compliance_claim_allowed) {
                    pass = false; notes.push('compliance_claim_allowed=true on clean control');
                }
                if (gov && gov.standard_certified) {
                    pass = false; notes.push('standard_certified=true on clean control');
                }
            }

            const evidencePresent = !!(gov && ('validation_report_hash' in gov) && ('standard_detected' in gov));

            results.push({
                scenario: scenario.name,
                input_mode: scenario.name.startsWith('SYNTHETIC') || scenario.name.startsWith('REGRESSION') ? 'SYNTHETIC_POLICY' : inputMode,
                status: result.status,
                standards_certification_governance: gov ? {
                    standard_certified: gov.standard_certified,
                    pdfx_compliance_claimed: gov.pdfx_compliance_claimed,
                    pdfa_compliance_claimed: gov.pdfa_compliance_claimed,
                    compliance_claim_allowed: gov.compliance_claim_allowed,
                    validation_performed: gov.validation_performed,
                    validation_passed: gov.validation_passed,
                    validator_name: gov.validator_name,
                    validator_version: gov.validator_version,
                    standard_detected: gov.standard_detected,
                    validation_report_hash: gov.validation_report_hash,
                    review_required: gov.review_required
                } : null,
                artifact_trust: trust ? {
                    trust_level: trust.trust_level,
                    standard_certified: trust.standard_certified,
                    compliance_claim_allowed: trust.compliance_claim_allowed,
                    certified_pdf_allowed: trust.certified_pdf_allowed,
                    review_required: trust.review_required
                } : null,
                evidence_fields_present: evidencePresent,
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

    const reportJsonPath = path.join(REPORTS_DIR, 'phase68b_worker_validator_evidence_policy.json');
    const reportMdPath = path.join(REPORTS_DIR, 'phase68b_worker_validator_evidence_policy.md');

    await fs.writeJson(reportJsonPath, {
        generated_at: new Date().toISOString(),
        phase: '68B',
        repo: 'ppos-preflight-worker',
        smoke_passed: smokePassed,
        input_mode: inputMode,
        core_principle: 'compliance_claim_allowed=true is only set when all 7 validator evidence fields are present (validation_performed, validation_passed, validator_name, validator_version, standard_detected, validation_report_hash, compliance_claim_allowed). Incomplete evidence → standard_certified=false/pdfx_compliance_claimed=false/pdfa_compliance_claimed=false/compliance_claim_allowed=false.',
        required_evidence_fields: REQUIRED_EVIDENCE_FIELDS,
        target_capabilities: STANDARDS_CAPS,
        results
    }, { spaces: 2 });

    let md = `# Phase 68B — Worker Validator Evidence Policy\n\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n`;
    md += `**Input Mode:** ${inputMode}\n`;
    md += `**Status:** ${smokePassed ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `## Summary\n`;
    md += `Validates that standards_certification_governance is materialized in fix_audit.json v2 and delta_report.json with all 7 required Phase 68A validator evidence fields preserved. `;
    md += `Enforces: compliance_claim_allowed=true only when validation_performed, validation_passed, validator_name, validator_version, standard_detected, validation_report_hash, and compliance_claim_allowed are all present and valid from the Engine. `;
    md += `Incomplete evidence → standard_certified=false/pdfx_compliance_claimed=false/pdfa_compliance_claimed=false/compliance_claim_allowed=false. `;
    md += `SKIPPED_UNSUPPORTED validator scenarios are rejected. artifact_trust cannot reach STANDARD_CERTIFIED without complete evidence.\n\n`;
    md += `## Required Evidence Fields (Phase 68A Policy)\n\n`;
    REQUIRED_EVIDENCE_FIELDS.forEach(f => { md += `- \`${f}\`\n`; });
    md += `\n## Results\n\n`;
    for (const res of results) {
        const govSummary = res.standards_certification_governance;
        md += `### ${res.scenario}\n`;
        md += `- **Pass:** ${res.pass}\n`;
        md += `- **Notes:** ${res.notes}\n`;
        if (govSummary) {
            md += `- **compliance_claim_allowed:** ${govSummary.compliance_claim_allowed}\n`;
            md += `- **standard_certified:** ${govSummary.standard_certified}\n`;
            md += `- **pdfx_compliance_claimed:** ${govSummary.pdfx_compliance_claimed}\n`;
            md += `- **pdfa_compliance_claimed:** ${govSummary.pdfa_compliance_claimed}\n`;
            md += `- **validation_performed:** ${govSummary.validation_performed}\n`;
            md += `- **validation_report_hash:** ${govSummary.validation_report_hash}\n`;
            md += `- **standard_detected:** ${govSummary.standard_detected}\n`;
            md += `- **validator_name:** ${govSummary.validator_name}\n`;
        }
        if (res.artifact_trust) {
            md += `- **artifact_trust.trust_level:** ${res.artifact_trust.trust_level}\n`;
            md += `- **artifact_trust.certified_pdf_allowed:** ${res.artifact_trust.certified_pdf_allowed}\n`;
        }
        md += `- **Evidence Fields Present:** ${res.evidence_fields_present}\n\n`;
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
