# Phase 73B — Worker Machine Readiness Governance

**Timestamp:** 2026-06-15T17:24:05.835Z
**Status:** ✅ PASS

## Summary

Validates that `machine_readiness_governance` is emitted in `fix_audit.json` v2 and `delta_report.json`, derived from the Engine's `machine_capability_signals` (Phase 73A) and the job's source findings. Enforces:

- `machine_capability_signals` (page/color/ink/finishing/standards/media signals) are preserved verbatim.
- `machine_match_required` is true whenever any signal indicates a potential machine-matching constraint (CMYK conversion, missing bleed, ink risk, finishing risk, inconsistent page geometry, or standards risk).
- `incompatible_machine_reasons` lists the advisory reason codes driving `machine_match_required`.
- `machine_match_authority`, `production_certified`, and `standard_certified` are always `false` — signals are advisory inputs to Phase 73D machine assignment only, never a certification authority.

## Results

### no findings, no metadata -> machine_match_required=false
- **Pass:** ✅
- **Notes:** OK
- **Status:** DEGRADED
- **machine_match_required:** false
- **incompatible_machine_reasons:** none
- **warnings:** PAGE_COUNT_UNAVAILABLE, PAGE_SIZE_UNAVAILABLE

### RGB images present -> REQUIRES_CMYK_CONVERSION
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **machine_match_required:** true
- **incompatible_machine_reasons:** REQUIRES_CMYK_CONVERSION
- **warnings:** PAGE_COUNT_UNAVAILABLE, PAGE_SIZE_UNAVAILABLE

### bleed missing finding -> BLEED_MISSING
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **machine_match_required:** true
- **incompatible_machine_reasons:** BLEED_MISSING, FINISHING_MARKS_RISK_MEDIUM
- **warnings:** PAGE_COUNT_UNAVAILABLE, PAGE_SIZE_UNAVAILABLE

### TAC exceeded -> INK_RISK_HIGH
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **machine_match_required:** true
- **incompatible_machine_reasons:** INK_RISK_HIGH
- **warnings:** PAGE_COUNT_UNAVAILABLE, PAGE_SIZE_UNAVAILABLE

### PDFX_INVALID standard -> STANDARD_INVALID
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **machine_match_required:** true
- **incompatible_machine_reasons:** STANDARD_INVALID
- **warnings:** PAGE_COUNT_UNAVAILABLE, PAGE_SIZE_UNAVAILABLE

### multiple findings -> multiple incompatible_machine_reasons
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **machine_match_required:** true
- **incompatible_machine_reasons:** REQUIRES_CMYK_CONVERSION, BLEED_MISSING, FINISHING_MARKS_RISK_HIGH, MIXED_ORIENTATION_DETECTED
- **warnings:** PAGE_COUNT_UNAVAILABLE, PAGE_SIZE_UNAVAILABLE

### REGRESSION: machine_readiness_governance present with required fields and invariants
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **machine_match_required:** false
- **incompatible_machine_reasons:** none
- **warnings:** PAGE_COUNT_UNAVAILABLE, PAGE_SIZE_UNAVAILABLE

