'use strict';
/**
 * Phase 72B Smoke Test — Worker Policy Profile Governance
 *
 * Tests that the Worker correctly emits policy_profile_governance in
 * fix_audit payloads, using the Engine evaluator in context.
 *
 * Strategy: unit-tests the governance evaluation path directly (without
 * running the full AutofixProcessor.process, which requires real PDFs/storage).
 * Validates that:
 *  1. policyProfile is resolved and governance is emitted
 *  2. profile_blockers drive readiness signals
 *  3. profile_warnings are preserved
 *  4. Governance invariants hold (no overclaims)
 *  5. evaluateFromFixAudit integration with Worker-style fix_audit payloads
 */

const path = require('path');
const fs   = require('fs');

// Load Engine evaluator (Worker requires the engine)
const ENGINE_POLICY_PATH = path.resolve(__dirname, '../../ppos-preflight-engine/policy');
const { evaluateFromFixAudit } = require(path.join(ENGINE_POLICY_PATH, 'PolicyProfileEvaluator'));
const { resolveProfile, BUILT_IN_PROFILES } = require(path.join(ENGINE_POLICY_PATH, 'PolicyProfileSchema'));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let PASS = 0, FAIL = 0;
const results = [];

function assert(condition, label, detail) {
    const pass = !!condition;
    if (pass) { console.log(`  ✅  ${label}`); PASS++; }
    else       { console.error(`  ❌  ${label}${detail ? ': ' + detail : ''}`); FAIL++; }
    results.push({ label, pass, detail: detail || null });
}

// ---------------------------------------------------------------------------
// Simulate the Worker's policy_profile_governance computation
// (mirrors AutofixProcessor.js Phase 72B logic)
// ---------------------------------------------------------------------------
function computePolicyProfileGovernance(policyProfile, sourceFindings, standardDetected) {
    const activeProfile = resolveProfile(policyProfile || 'NONE');
    return evaluateFromFixAudit(
        activeProfile,
        { findings: sourceFindings || [], plan: [], issues: [] },
        { detected_standard: standardDetected || null, tac_measured: null }
    );
}

// ---------------------------------------------------------------------------
// PART 1 — Basic governance emission
// ---------------------------------------------------------------------------
console.log('\n\n=== PART 1 — Basic Governance Emission ===\n');

// 1.1 NONE profile → always passes, no blockers
{
    const gov = computePolicyProfileGovernance('NONE', [], null);
    assert(gov.profile_id === 'NONE',            '1.1 profile_id=NONE');
    assert(gov.profile_passed === true,          '1.1 profile_passed=true for NONE');
    assert(gov.profile_blockers.length === 0,    '1.1 no blockers for NONE');
    assert(gov.production_certified === false,   '1.1 production_certified=false');
    assert(gov.standard_certified === false,     '1.1 standard_certified=false');
}

// 1.2 Null profile → falls back to NONE
{
    const gov = computePolicyProfileGovernance(null, [], null);
    assert(gov.profile_id === 'NONE', '1.2 null policyProfile → NONE profile');
    assert(gov.profile_passed === true, '1.2 null profile → passed');
}

// 1.3 OFFSET_STANDARD profile with no findings → passes
{
    const gov = computePolicyProfileGovernance('OFFSET_STANDARD', [], null);
    assert(gov.profile_id === 'OFFSET_STANDARD', '1.3 profile_id=OFFSET_STANDARD');
    assert(gov.profile_passed === true,           '1.3 OFFSET_STANDARD with no findings → passed');
}

// ---------------------------------------------------------------------------
// PART 2 — Profile blockers drive readiness
// ---------------------------------------------------------------------------
console.log('\n\n=== PART 2 — Profile Blockers Drive Readiness ===\n');

// 2.1 Bleed missing on PDFX4_STRICT → blocked
{
    const gov = computePolicyProfileGovernance('PDFX4_STRICT', [{ id: 'BLEED_MISSING' }], null);
    assert(gov.profile_passed === false,                              '2.1 PDFX4_STRICT + BLEED_MISSING → failed');
    assert(gov.profile_blockers.includes('PROFILE_BLEED_REQUIRED'), '2.1 PROFILE_BLEED_REQUIRED blocker');
    assert(gov.production_certified === false,                       '2.1 production_certified=false');
    assert(gov.standard_certified === false,                         '2.1 standard_certified=false');
}

// 2.2 JavaScript on security-restricted profile → blocked
{
    const gov = computePolicyProfileGovernance('PDFX4_STRICT', [{ id: 'PDF_JAVASCRIPT_PRESENT' }], null);
    assert(gov.profile_passed === false,                                    '2.2 JS on PDFX4_STRICT → failed');
    assert(gov.profile_blockers.includes('PROFILE_NO_JAVASCRIPT_VIOLATED'), '2.2 PROFILE_NO_JAVASCRIPT_VIOLATED');
}

// 2.3 TAC exceeded on OFFSET_STANDARD
{
    const gov = computePolicyProfileGovernance('OFFSET_STANDARD', [{ id: 'COLOR_TOTAL_INK_COVERAGE_EXCEEDED' }], null);
    assert(gov.profile_passed === false,                                  '2.3 TAC exceeded → failed');
    assert(gov.profile_blockers.includes('PROFILE_TAC_LIMIT_EXCEEDED'), '2.3 PROFILE_TAC_LIMIT_EXCEEDED');
}

// 2.4 RGB on CMYK-only profile
{
    const gov = computePolicyProfileGovernance('OFFSET_STANDARD', [{ id: 'RGB_IMAGES_PRESENT' }], null);
    assert(gov.profile_blockers.includes('PROFILE_CMYK_REQUIRED'), '2.4 PROFILE_CMYK_REQUIRED on OFFSET_STANDARD');
}

// 2.5 Unembedded fonts on strict profile
{
    const gov = computePolicyProfileGovernance('PDFX4_STRICT', [{ id: 'FONT_NOT_EMBEDDED' }], null);
    assert(gov.profile_blockers.includes('PROFILE_FONTS_MUST_BE_EMBEDDED'), '2.5 PROFILE_FONTS_MUST_BE_EMBEDDED');
}

// 2.6 Multiple blockers accumulated
{
    const gov = computePolicyProfileGovernance('PDFX4_STRICT', [
        { id: 'BLEED_MISSING' },
        { id: 'PDF_JAVASCRIPT_PRESENT' },
        { id: 'RGB_IMAGES_PRESENT' },
        { id: 'FONT_NOT_EMBEDDED' }
    ], null);
    assert(gov.profile_passed === false,            '2.6 Multiple violations → failed');
    assert(gov.profile_blockers.length >= 4,        '2.6 At least 4 blockers emitted');
    assert(gov.production_certified === false,      '2.6 production_certified=false with blockers');
}

// ---------------------------------------------------------------------------
// PART 3 — Profile warnings preserved
// ---------------------------------------------------------------------------
console.log('\n\n=== PART 3 — Profile Warnings Preserved ===\n');

// 3.1 PDFX4_STRICT with no detected standard → warning emitted
{
    const gov = computePolicyProfileGovernance('PDFX4_STRICT', [], null);
    assert(gov.profile_warnings.some(w => w.includes('PROFILE_STANDARD_REQUIRED_BUT_NOT_VALIDATED')),
        '3.1 Standard required but not validated → warning');
    assert(gov.profile_passed === true, '3.1 Warning-only → profile_passed=true');
}

// 3.2 Warnings do not block profile_passed
{
    const gov = computePolicyProfileGovernance('PDFX4_STRICT', [], null);
    // Has warning but no blockers from other domains
    assert(gov.profile_blockers.length === 0, '3.2 Warnings only → no blockers');
}

// ---------------------------------------------------------------------------
// PART 4 — Governance invariants (no overclaims)
// ---------------------------------------------------------------------------
console.log('\n\n=== PART 4 — Governance Invariants (No Overclaims) ===\n');

const ALL_PROFILES = Object.keys(BUILT_IN_PROFILES);
for (const pid of ALL_PROFILES) {
    // Test with no findings (best case for each profile)
    const gov = computePolicyProfileGovernance(pid, [], null);
    assert(gov.production_certified === false,      `4.1 ${pid}: production_certified=false (always)`);
    assert(gov.standard_certified === false,        `4.2 ${pid}: standard_certified=false (always)`);
    assert(gov.compliance_claim_allowed === false,  `4.3 ${pid}: compliance_claim_allowed=false (always)`);
    assert(gov.print_ready_claim_allowed === false, `4.4 ${pid}: print_ready_claim_allowed=false (always)`);
}

// ---------------------------------------------------------------------------
// PART 5 — evaluateFromFixAudit with Worker-style payloads
// ---------------------------------------------------------------------------
console.log('\n\n=== PART 5 — evaluateFromFixAudit with Worker-Style Payloads ===\n');

// 5.1 From fix_audit.plan items (source_finding)
{
    const fixAuditPayload = {
        findings: [],
        plan: [
            { fix_id: 'APPLY_BLEED', source_finding: 'BLEED_MISSING', planned: false, skip_reason: 'PROFILE_CONSTRAINT_VIOLATION' },
            { fix_id: 'STRIP_JAVASCRIPT', source_finding: 'PDF_JAVASCRIPT_PRESENT', planned: false }
        ]
    };
    const gov = evaluateFromFixAudit('PDFX4_STRICT', fixAuditPayload, {});
    assert(gov.profile_blockers.includes('PROFILE_BLEED_REQUIRED'),       '5.1 Bleed blocker from plan[].source_finding');
    assert(gov.profile_blockers.includes('PROFILE_NO_JAVASCRIPT_VIOLATED'),'5.1 JS blocker from plan[].source_finding');
}

// 5.2 From fix_audit.findings[] (primary path in Worker)
{
    const fixAuditPayload = {
        findings: [
            { id: 'COLOR_TOTAL_INK_COVERAGE_EXCEEDED', tac_value: 340 },
            { id: 'RGB_IMAGES_PRESENT' }
        ],
        plan: []
    };
    const gov = evaluateFromFixAudit('SHEETFED_HIGH_END', fixAuditPayload, {});
    assert(gov.profile_blockers.includes('PROFILE_TAC_LIMIT_EXCEEDED'), '5.2 TAC blocker from findings[]');
    assert(gov.profile_blockers.includes('PROFILE_CMYK_REQUIRED'),      '5.2 CMYK blocker from findings[]');
}

// 5.3 Empty fix_audit → NONE profile passes
{
    const gov = evaluateFromFixAudit('NONE', {}, {});
    assert(gov.profile_passed === true,       '5.3 Empty fix_audit + NONE → passed');
    assert(gov.profile_blockers.length === 0, '5.3 Empty fix_audit + NONE → no blockers');
}

// 5.4 fix_audit with issues[] array
{
    const fixAuditPayload = {
        issues: [{ id: 'FONT_NOT_EMBEDDED' }, { id: 'TYPE3_FONT_DETECTED' }]
    };
    const gov = evaluateFromFixAudit('PDFX4_STRICT', fixAuditPayload, {});
    assert(gov.profile_blockers.includes('PROFILE_FONTS_MUST_BE_EMBEDDED'), '5.4 Font blocker from issues[]');
    assert(gov.profile_blockers.includes('PROFILE_TYPE3_FONTS_NOT_ALLOWED'),'5.4 Type3 blocker from issues[]');
}

// ---------------------------------------------------------------------------
// PART 6 — Worker integration structure check
// ---------------------------------------------------------------------------
console.log('\n\n=== PART 6 — Worker Integration Structure ===\n');

// Verify AutofixProcessor contains the required 72B integration code
{
    const processorSrc = fs.readFileSync(
        path.resolve(__dirname, '../processors/AutofixProcessor.js'),
        'utf8'
    );
    assert(processorSrc.includes('policy_profile_governance'),             '6.1 AutofixProcessor emits policy_profile_governance');
    assert(processorSrc.includes('evaluateFromFixAudit'),                  '6.2 AutofixProcessor imports evaluateFromFixAudit');
    assert(processorSrc.includes('PolicyProfileEvaluator'),               '6.3 AutofixProcessor imports PolicyProfileEvaluator');
    assert(processorSrc.includes('resolveProfile'),                        '6.4 AutofixProcessor imports resolveProfile');
    assert(processorSrc.includes('PROFILE_EVALUATION_SKIPPED'),           '6.5 AutofixProcessor has non-fatal fallback');
    // Both fix_audit and delta_report should have it
    const govOccurrences = (processorSrc.match(/policy_profile_governance/g) || []).length;
    assert(govOccurrences >= 2, `6.6 policy_profile_governance appears in both fix_audit and delta_report (found ${govOccurrences})`);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

const smokePassed = FAIL === 0;
const report = {
    generated_at: new Date().toISOString(),
    phase: '72B',
    repo: 'ppos-preflight-worker',
    category: 'worker_policy_profile_governance',
    smoke_passed: smokePassed,
    governance: {
        profile_pass_implies_production_certified: false,
        profile_pass_implies_standard_certified: false,
        profile_blockers_are_advisory: false,  // blockers ARE blocking (not just advisory)
        profile_warnings_are_advisory: true
    },
    summary: { total: PASS + FAIL, passed: PASS, failed: FAIL },
    results
};

const jsonPath = path.join(reportsDir, 'phase72b_worker_policy_profile_governance.json');
const mdPath   = path.join(reportsDir, 'phase72b_worker_policy_profile_governance.md');
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const md = [
    '# Phase 72B — Worker Policy Profile Governance',
    '',
    `**Generated:** ${report.generated_at}  `,
    `**Smoke:** ${smokePassed ? '✅ PASSED' : '❌ FAILED'}  `,
    `**Results:** ${PASS}/${PASS + FAIL} passed`,
    '',
    '## Governance',
    '| Invariant | Value |',
    '|-----------|-------|',
    '| profile_pass → production_certified | **false** |',
    '| profile_pass → standard_certified | **false** |',
    '| profile_blockers are blocking (not just advisory) | **true** |',
    '',
    '## Test Results',
    '| # | Test | Pass |',
    '|---|------|------|',
    ...results.map((r, i) => `| ${i+1} | ${r.label} | ${r.pass ? '✅' : '❌'} |`),
    ''
].join('\n');
fs.writeFileSync(mdPath, md);

console.log(`\n${'='.repeat(70)}`);
console.log(`Phase 72B — Worker Policy Profile Governance`);
console.log(`Results: ${PASS}/${PASS + FAIL} passed${FAIL > 0 ? ` (${FAIL} FAILED)` : ''}`);
console.log(`Smoke: ${smokePassed ? 'PASSED ✅' : 'FAILED ❌'}`);
console.log(`Reports: ${jsonPath}`);
console.log('='.repeat(70));

process.exit(smokePassed ? 0 : 1);
