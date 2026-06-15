# Phase 74B — Worker Audit Bundle Governance

**Timestamp:** 2026-06-15T17:34:00.240Z
**Status:** ✅ PASS

## Summary

Validates that `audit_bundle_governance` is emitted in both `fix_audit.json` and `delta_report.json`. Enforces:

- `fix_audit_hash` and `delta_report_hash` are stable SHA-256 digests of the respective report contents (computed prior to attaching `audit_bundle_governance` itself).
- `governance_domains` enumerates every `*_governance` section plus `artifact_trust` present in the bundle.
- `artifact_trust` is preserved verbatim for downstream audit consumers.
- `production_certified` and `standard_certified` are always `false` — the bundle is a packaging/evidence index, never a certification authority.
- `audit_bundle_governance` is identical across `fix_audit.json` and `delta_report.json`.

## Results

### baseline run -> audit_bundle_governance present with hashes and governance domains
- **Pass:** ✅
- **Notes:** OK
- **Status:** DEGRADED
- **fix_audit_hash:** 639b39c4181c79a5076f6373655c83585a9a00f7f25e0a55d4a329c39304937c
- **delta_report_hash:** ba2b9fc8cd3bcb4e8bea9697b5a248c155bfbe404a4e428f8ef0eb0c07ebcd1f
- **governance_domains:** artifact_trust, standards_certification_governance, structural_metadata_governance, page_marks_governance, security_interactivity_governance, ink_governance, selective_image_governance, font_governance, transparency_overprint_physical_governance, visual_diff_governance, proof_approval_governance, heavy_pdf_probe_governance, production_package_governance, policy_profile_governance, machine_readiness_governance
- **bundle_complete:** true

### review required -> audit_bundle_governance present with review warning
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **fix_audit_hash:** c539b6ff83275771edbb0bd6b6a35d5aafdde062c31ffcb016ddd50d46aadc14
- **delta_report_hash:** f10fd49b6cb3373b7fe2ec35e49834ec7368ccecc8e36f82017ecf9713e36ba4
- **governance_domains:** artifact_trust, standards_certification_governance, structural_metadata_governance, page_marks_governance, security_interactivity_governance, ink_governance, selective_image_governance, font_governance, transparency_overprint_physical_governance, visual_diff_governance, proof_approval_governance, heavy_pdf_probe_governance, production_package_governance, policy_profile_governance, machine_readiness_governance
- **bundle_complete:** true

### REGRESSION: audit_bundle_governance present identically in fix_audit.json and delta_report.json
- **Pass:** ✅
- **Notes:** OK
- **Status:** COMPLETED
- **fix_audit_hash:** 9a135315356d942c169e3337f3bc5c31b38f9261daa29c07de331066a46c3340
- **delta_report_hash:** 056e54a961e6fac7b1a3ef96a4725f8ddbdddbe1df883663a2f193aa2cdec1c5
- **governance_domains:** artifact_trust, standards_certification_governance, structural_metadata_governance, page_marks_governance, security_interactivity_governance, ink_governance, selective_image_governance, font_governance, transparency_overprint_physical_governance, visual_diff_governance, proof_approval_governance, heavy_pdf_probe_governance, production_package_governance, policy_profile_governance, machine_readiness_governance
- **bundle_complete:** true

