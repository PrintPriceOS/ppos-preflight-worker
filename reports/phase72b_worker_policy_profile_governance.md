# Phase 72B — Worker Policy Profile Governance

**Generated:** 2026-06-10T18:49:04.795Z  
**Smoke:** ✅ PASSED  
**Results:** 63/63 passed

## Governance
| Invariant | Value |
|-----------|-------|
| profile_pass → production_certified | **false** |
| profile_pass → standard_certified | **false** |
| profile_blockers are blocking (not just advisory) | **true** |

## Test Results
| # | Test | Pass |
|---|------|------|
| 1 | 1.1 profile_id=NONE | ✅ |
| 2 | 1.1 profile_passed=true for NONE | ✅ |
| 3 | 1.1 no blockers for NONE | ✅ |
| 4 | 1.1 production_certified=false | ✅ |
| 5 | 1.1 standard_certified=false | ✅ |
| 6 | 1.2 null policyProfile → NONE profile | ✅ |
| 7 | 1.2 null profile → passed | ✅ |
| 8 | 1.3 profile_id=OFFSET_STANDARD | ✅ |
| 9 | 1.3 OFFSET_STANDARD with no findings → passed | ✅ |
| 10 | 2.1 PDFX4_STRICT + BLEED_MISSING → failed | ✅ |
| 11 | 2.1 PROFILE_BLEED_REQUIRED blocker | ✅ |
| 12 | 2.1 production_certified=false | ✅ |
| 13 | 2.1 standard_certified=false | ✅ |
| 14 | 2.2 JS on PDFX4_STRICT → failed | ✅ |
| 15 | 2.2 PROFILE_NO_JAVASCRIPT_VIOLATED | ✅ |
| 16 | 2.3 TAC exceeded → failed | ✅ |
| 17 | 2.3 PROFILE_TAC_LIMIT_EXCEEDED | ✅ |
| 18 | 2.4 PROFILE_CMYK_REQUIRED on OFFSET_STANDARD | ✅ |
| 19 | 2.5 PROFILE_FONTS_MUST_BE_EMBEDDED | ✅ |
| 20 | 2.6 Multiple violations → failed | ✅ |
| 21 | 2.6 At least 4 blockers emitted | ✅ |
| 22 | 2.6 production_certified=false with blockers | ✅ |
| 23 | 3.1 Standard required but not validated → warning | ✅ |
| 24 | 3.1 Warning-only → profile_passed=true | ✅ |
| 25 | 3.2 Warnings only → no blockers | ✅ |
| 26 | 4.1 NONE: production_certified=false (always) | ✅ |
| 27 | 4.2 NONE: standard_certified=false (always) | ✅ |
| 28 | 4.3 NONE: compliance_claim_allowed=false (always) | ✅ |
| 29 | 4.4 NONE: print_ready_claim_allowed=false (always) | ✅ |
| 30 | 4.1 OFFSET_STANDARD: production_certified=false (always) | ✅ |
| 31 | 4.2 OFFSET_STANDARD: standard_certified=false (always) | ✅ |
| 32 | 4.3 OFFSET_STANDARD: compliance_claim_allowed=false (always) | ✅ |
| 33 | 4.4 OFFSET_STANDARD: print_ready_claim_allowed=false (always) | ✅ |
| 34 | 4.1 PDFX4_STRICT: production_certified=false (always) | ✅ |
| 35 | 4.2 PDFX4_STRICT: standard_certified=false (always) | ✅ |
| 36 | 4.3 PDFX4_STRICT: compliance_claim_allowed=false (always) | ✅ |
| 37 | 4.4 PDFX4_STRICT: print_ready_claim_allowed=false (always) | ✅ |
| 38 | 4.1 PDFA2B_ARCHIVE: production_certified=false (always) | ✅ |
| 39 | 4.2 PDFA2B_ARCHIVE: standard_certified=false (always) | ✅ |
| 40 | 4.3 PDFA2B_ARCHIVE: compliance_claim_allowed=false (always) | ✅ |
| 41 | 4.4 PDFA2B_ARCHIVE: print_ready_claim_allowed=false (always) | ✅ |
| 42 | 4.1 DIGITAL_SCREEN: production_certified=false (always) | ✅ |
| 43 | 4.2 DIGITAL_SCREEN: standard_certified=false (always) | ✅ |
| 44 | 4.3 DIGITAL_SCREEN: compliance_claim_allowed=false (always) | ✅ |
| 45 | 4.4 DIGITAL_SCREEN: print_ready_claim_allowed=false (always) | ✅ |
| 46 | 4.1 SHEETFED_HIGH_END: production_certified=false (always) | ✅ |
| 47 | 4.2 SHEETFED_HIGH_END: standard_certified=false (always) | ✅ |
| 48 | 4.3 SHEETFED_HIGH_END: compliance_claim_allowed=false (always) | ✅ |
| 49 | 4.4 SHEETFED_HIGH_END: print_ready_claim_allowed=false (always) | ✅ |
| 50 | 5.1 Bleed blocker from plan[].source_finding | ✅ |
| 51 | 5.1 JS blocker from plan[].source_finding | ✅ |
| 52 | 5.2 TAC blocker from findings[] | ✅ |
| 53 | 5.2 CMYK blocker from findings[] | ✅ |
| 54 | 5.3 Empty fix_audit + NONE → passed | ✅ |
| 55 | 5.3 Empty fix_audit + NONE → no blockers | ✅ |
| 56 | 5.4 Font blocker from issues[] | ✅ |
| 57 | 5.4 Type3 blocker from issues[] | ✅ |
| 58 | 6.1 AutofixProcessor emits policy_profile_governance | ✅ |
| 59 | 6.2 AutofixProcessor imports evaluateFromFixAudit | ✅ |
| 60 | 6.3 AutofixProcessor imports PolicyProfileEvaluator | ✅ |
| 61 | 6.4 AutofixProcessor imports resolveProfile | ✅ |
| 62 | 6.5 AutofixProcessor has non-fatal fallback | ✅ |
| 63 | 6.6 policy_profile_governance appears in both fix_audit and delta_report (found 2) | ✅ |
