# Phase 63E.2 — Worker Security/Interactivity End-to-End Regression

**Timestamp:** 2026-06-08T15:29:26.126Z
**Input Mode:** ENGINE_REPORT
**Status:** ✅ PASS

## Summary
Consumes Engine 63E.1 regression scenarios end-to-end and re-validates that AutofixProcessor preserves security_interactivity_governance (fix_audit + delta_report), per-fix evidence across APPLIED/SKIPPED/FAILED buckets, and artifact_trust (trust_level=FIXED_REVIEW_REQUIRED, review_required forced true, certified_pdf_allowed=false, blocked_by_governance_domains includes security_interactivity), with no standards/production overclaim leakage and no certified.pdf filename trust.

## Results

### STRIP_JAVASCRIPT removes or skips honestly
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### REMOVE_LAUNCH_ACTIONS removes or skips honestly
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### REMOVE_EMBEDDED_FILES removes or skips honestly
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### REMOVE_DOCUMENT_OPEN_ACTIONS removes or skips honestly
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### REMOVE_PAGE_OPEN_ACTIONS removes or skips honestly
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### FLATTEN_ANNOTATIONS applies only if safe, otherwise SKIPPED_UNSUPPORTED
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### FLATTEN_FORMS applies only if safe, otherwise SKIPPED_UNSUPPORTED
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### mixed_interactive_content preserves evidence (STRIP_JAVASCRIPT)
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### mixed_interactive_content preserves evidence (FLATTEN_FORMS)
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### clean_control returns no action with evidence (STRIP_JAVASCRIPT)
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### clean_control returns no action with evidence (FLATTEN_FORMS)
- **Pass:** true
- **Notes:** OK
- **Review Required:** false
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### REGRESSION: standards overclaim from security/interactivity fix must be rejected
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### REGRESSION: certified.pdf filename must not be trusted by name
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

### REGRESSION: evidence preservation across applied/skipped/failed buckets
- **Pass:** true
- **Notes:** OK
- **Review Required:** true
- **Production Certified:** false
- **Standard Certified:** false
- **Evidence Present:** true

