# Phase 62F-B — Worker Heavy PDF Probe Governance

**Timestamp:** 2026-06-09T19:21:38.882Z
**Input Mode:** ENGINE_62F_REPORT_AUGMENTED
**Status:** ✅ PASS

## Summary

Validates that `heavy_pdf_probe_governance` is preserved from Engine probe semantics into Worker `fix_audit.json` v2 and `delta_report.json`.

### Acceptance Criteria

1. ✅ Worker preserves `heavy_pdf_probe_governance` in `fix_audit.json` and `delta_report.json`
2. ✅ Worker preserves tool semantic statuses (qpdf, pdfimages)
3. ✅ Worker does not collapse warnings into generic fatal failure
4. ✅ Worker keeps fatal failures fatal
5. ✅ `artifact_trust` is conservative (review_required wins)
6. ✅ certified.pdf not trusted by filename when review_required=true
7. ✅ No production/standards overclaim from probe semantics
8. ✅ strict_forensic_mode blocks certification even for warning-only probes
9. ✅ Evidence fields preserved end-to-end
10. ✅ `blocked_by_governance_domains` includes heavy_pdf_probe when applicable

### Non-Negotiable Invariants

- `heavy_pdf_probe_governance.production_certified` always `false`
- `heavy_pdf_probe_governance.standard_certified` always `false`
- `heavy_pdf_probe_governance.pdfx_compliance_claimed` always `false`
- `heavy_pdf_probe_governance.pdfa_compliance_claimed` always `false`
- `heavy_pdf_probe_governance.compliance_claim_allowed` always `false`

## Results

| # | Scenario | Pass | Trust Level | Review Required | Fatal Doc Failure | Tool qpdf | Tool pdfimages | Overclaim Guard | Notes |
|---|----------|------|-------------|-----------------|-------------------|-----------|----------------|-----------------|-------|
| 1 | qpdf WARNING_ONLY — governance preserved, not generic fatal | ✅ | DEGRADED_ANALYSIS_REVIEW_REQUIRED | true | false | WARNING_ONLY | N/A | ✅ | OK |
| 2 | pdfimages WARNING_ONLY — governance preserved, not generic fatal | ✅ | DEGRADED_ANALYSIS_REVIEW_REQUIRED | true | false | N/A | WARNING_ONLY | ✅ | OK |
| 3 | qpdf FAILED_FATAL — fatal preserved, blocks production | ✅ | ANALYSIS_FAILED_REVIEW_REQUIRED | true | true | FAILED_FATAL | N/A | ✅ | OK |
| 4 | pdfimages FAILED_NO_OUTPUT — fatal preserved, blocks production | ✅ | ANALYSIS_FAILED_REVIEW_REQUIRED | true | true | N/A | FAILED_NO_OUTPUT | ✅ | OK |
| 5 | heavy file degraded_but_usable=true — review required, degraded trust level | ✅ | DEGRADED_ANALYSIS_REVIEW_REQUIRED | true | false | WARNING_ONLY | WARNING_ONLY | ✅ | OK |
| 6 | heavy file fatal_document_failure=true — requires remediation, max restrictions | ✅ | ANALYSIS_FAILED_REVIEW_REQUIRED | true | true | FAILED_FATAL | N/A | ✅ | OK |
| 7 | certified.pdf filename regression — suppressed when review_required=true | ✅ | DEGRADED_ANALYSIS_REVIEW_REQUIRED | true | false | WARNING_ONLY | N/A | ✅ | OK |
| 8 | standards overclaim regression — no PDF/X or PDF/A from heavy PDF probe | ✅ | DEGRADED_ANALYSIS_REVIEW_REQUIRED | true | false | WARNING_ONLY | N/A | ✅ | OK |
| 9 | strict_forensic_mode=true — warning-only probes block certification | ✅ | FIXED_REVIEW_REQUIRED | true | false | WARNING_ONLY | N/A | ✅ | OK |
| 10 | evidence preservation — probe evidence and tool semantics preserved end-to-end | ✅ | DEGRADED_ANALYSIS_REVIEW_REQUIRED | true | false | WARNING_ONLY | N/A | ✅ | OK |

## Detailed Results

### qpdf WARNING_ONLY — governance preserved, not generic fatal
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** DEGRADED_ANALYSIS_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** false
- **Analysis Degraded:** true
- **Degraded But Usable:** true
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** WARNING_ONLY
- **pdfimages Semantic Status:** null
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### pdfimages WARNING_ONLY — governance preserved, not generic fatal
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** DEGRADED_ANALYSIS_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** false
- **Analysis Degraded:** true
- **Degraded But Usable:** true
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** null
- **pdfimages Semantic Status:** WARNING_ONLY
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### qpdf FAILED_FATAL — fatal preserved, blocks production
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** ANALYSIS_FAILED_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** true
- **Analysis Degraded:** true
- **Degraded But Usable:** false
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** FAILED_FATAL
- **pdfimages Semantic Status:** null
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### pdfimages FAILED_NO_OUTPUT — fatal preserved, blocks production
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** ANALYSIS_FAILED_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** true
- **Analysis Degraded:** true
- **Degraded But Usable:** false
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** null
- **pdfimages Semantic Status:** FAILED_NO_OUTPUT
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### heavy file degraded_but_usable=true — review required, degraded trust level
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** DEGRADED_ANALYSIS_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** false
- **Analysis Degraded:** true
- **Degraded But Usable:** true
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** WARNING_ONLY
- **pdfimages Semantic Status:** WARNING_ONLY
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### heavy file fatal_document_failure=true — requires remediation, max restrictions
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** ANALYSIS_FAILED_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** true
- **Analysis Degraded:** true
- **Degraded But Usable:** false
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** FAILED_FATAL
- **pdfimages Semantic Status:** null
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### certified.pdf filename regression — suppressed when review_required=true
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** DEGRADED_ANALYSIS_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** false
- **Analysis Degraded:** true
- **Degraded But Usable:** true
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** WARNING_ONLY
- **pdfimages Semantic Status:** null
- **Blocked By:** ["standards_certification","heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### standards overclaim regression — no PDF/X or PDF/A from heavy PDF probe
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** DEGRADED_ANALYSIS_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** false
- **Analysis Degraded:** true
- **Degraded But Usable:** true
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** WARNING_ONLY
- **pdfimages Semantic Status:** null
- **Blocked By:** ["standards_certification","heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### strict_forensic_mode=true — warning-only probes block certification
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** FIXED_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** false
- **Analysis Degraded:** false
- **Degraded But Usable:** false
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** WARNING_ONLY
- **pdfimages Semantic Status:** null
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

### evidence preservation — probe evidence and tool semantics preserved end-to-end
- **Pass:** ✅
- **Notes:** OK
- **Trust Level:** DEGRADED_ANALYSIS_REVIEW_REQUIRED
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Certified PDF Allowed:** false
- **pdfx_compliance_claimed:** false
- **pdfa_compliance_claimed:** false
- **Heavy PDF Detected:** true
- **Fatal Document Failure:** false
- **Analysis Degraded:** true
- **Degraded But Usable:** true
- **Probe Semantics Applied:** true
- **qpdf Semantic Status:** WARNING_ONLY
- **pdfimages Semantic Status:** null
- **Blocked By:** ["heavy_pdf_probe"]
- **Overclaim Guard Passed:** ✅

