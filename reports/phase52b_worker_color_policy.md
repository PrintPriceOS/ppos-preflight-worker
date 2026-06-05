# Phase 52B Smoke Test Report

## Scenario A: CONVERT_CMYK blocks certification
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692986432-992",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "REVIEW_REQUIRED",
  "requested_fixes": [
    "CONVERT_CMYK"
  ],
  "applied_fixes": [
    {
      "fix_id": "CONVERT_CMYK",
      "status": "APPLIED"
    }
  ],
  "skipped_fixes": [],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": true,
  "review_required_reasons": [
    "CONVERT_CMYK"
  ],
  "production_certified": false,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:26.695Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692986432-992",
  "changes": [
    "CONVERT_CMYK"
  ],
  "boxes_changed": [],
  "color_converted": true,
  "interactive_removed": false,
  "skipped_fixes": [],
  "visual_review_required": true,
  "color_governance": {
    "highest_color_risk": "HIGH",
    "destructive_color_fix_applied": true,
    "unsupported_color_fixes": [],
    "review_required_color_reasons": [
      "CONVERT_CMYK"
    ],
    "production_certified": false,
    "certified_pdf_allowed": false
  }
}
```

## Scenario B: INJECT_OUTPUT_INTENT alone
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692986700-747",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "SAFE",
  "requested_fixes": [
    "INJECT_OUTPUT_INTENT"
  ],
  "applied_fixes": [
    {
      "fix_id": "INJECT_OUTPUT_INTENT",
      "status": "APPLIED"
    }
  ],
  "skipped_fixes": [],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": false,
  "review_required_reasons": [],
  "production_certified": true,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:26.934Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692986700-747",
  "changes": [
    "INJECT_OUTPUT_INTENT"
  ],
  "boxes_changed": [],
  "color_converted": false,
  "interactive_removed": false,
  "skipped_fixes": [],
  "visual_review_required": false,
  "color_governance": {
    "highest_color_risk": "LOW",
    "destructive_color_fix_applied": false,
    "unsupported_color_fixes": [],
    "review_required_color_reasons": [],
    "production_certified": true,
    "certified_pdf_allowed": false
  }
}
```

## Scenario C: INJECT_OUTPUT_INTENT + ICC
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692986937-666",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "REVIEW_REQUIRED",
  "requested_fixes": [
    "INJECT_OUTPUT_INTENT"
  ],
  "applied_fixes": [
    {
      "fix_id": "INJECT_OUTPUT_INTENT",
      "status": "APPLIED"
    }
  ],
  "skipped_fixes": [],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": true,
  "review_required_reasons": [
    "ICC_MISMATCH"
  ],
  "production_certified": false,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:27.172Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692986937-666",
  "changes": [
    "INJECT_OUTPUT_INTENT"
  ],
  "boxes_changed": [],
  "color_converted": false,
  "interactive_removed": false,
  "skipped_fixes": [],
  "visual_review_required": true,
  "color_governance": {
    "highest_color_risk": "HIGH",
    "destructive_color_fix_applied": false,
    "unsupported_color_fixes": [],
    "review_required_color_reasons": [
      "ICC_MISMATCH"
    ],
    "production_certified": false,
    "certified_pdf_allowed": false
  }
}
```

## Scenario D: Unsupported REDUCE_TAC is skipped
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692987175-21",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "REVIEW_REQUIRED",
  "requested_fixes": [
    "REDUCE_TAC"
  ],
  "applied_fixes": [],
  "skipped_fixes": [
    {
      "fix_id": "REDUCE_TAC",
      "status": "SKIPPED",
      "reason": "UNSUPPORTED_COLOR_FIX_WAS_REPORTED_AS_APPLIED",
      "message": "Capability is not fully supported or is high-risk.",
      "requires_human_review": true,
      "production_safe": false,
      "moved_from_applied_to_skipped": true
    }
  ],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": true,
  "review_required_reasons": [
    "REDUCE_TAC"
  ],
  "production_certified": false,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:27.401Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692987175-21",
  "changes": [],
  "boxes_changed": [],
  "color_converted": false,
  "interactive_removed": false,
  "skipped_fixes": [
    {
      "fix_id": "REDUCE_TAC",
      "reason": "UNSUPPORTED_COLOR_FIX_WAS_REPORTED_AS_APPLIED"
    }
  ],
  "visual_review_required": true,
  "color_governance": {
    "highest_color_risk": "HIGH",
    "destructive_color_fix_applied": false,
    "unsupported_color_fixes": [
      "REDUCE_TAC"
    ],
    "review_required_color_reasons": [
      "REDUCE_TAC"
    ],
    "production_certified": false,
    "certified_pdf_allowed": false
  }
}
```

## Scenario E: RICH_BLACK_TEXT finding
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692987404-929",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "REVIEW_REQUIRED",
  "requested_fixes": [],
  "applied_fixes": [],
  "skipped_fixes": [],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": true,
  "review_required_reasons": [
    "RICH_BLACK_TEXT"
  ],
  "production_certified": false,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:27.638Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692987404-929",
  "changes": [],
  "boxes_changed": [],
  "color_converted": false,
  "interactive_removed": false,
  "skipped_fixes": [],
  "visual_review_required": true,
  "color_governance": {
    "highest_color_risk": "HIGH",
    "destructive_color_fix_applied": false,
    "unsupported_color_fixes": [],
    "review_required_color_reasons": [
      "RICH_BLACK_TEXT"
    ],
    "production_certified": false,
    "certified_pdf_allowed": false
  }
}
```

## Scenario F: REGISTRATION_COLOR_MISUSE finding
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692987641-298",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "REVIEW_REQUIRED",
  "requested_fixes": [],
  "applied_fixes": [],
  "skipped_fixes": [],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": true,
  "review_required_reasons": [
    "REGISTRATION_COLOR_MISUSE"
  ],
  "production_certified": false,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:27.874Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692987641-298",
  "changes": [],
  "boxes_changed": [],
  "color_converted": false,
  "interactive_removed": false,
  "skipped_fixes": [],
  "visual_review_required": true,
  "color_governance": {
    "highest_color_risk": "HIGH",
    "destructive_color_fix_applied": false,
    "unsupported_color_fixes": [],
    "review_required_color_reasons": [
      "REGISTRATION_COLOR_MISUSE"
    ],
    "production_certified": false,
    "certified_pdf_allowed": false
  }
}
```

## Scenario G: MIXED_RGB_CMYK finding
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692987877-192",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "REVIEW_REQUIRED",
  "requested_fixes": [],
  "applied_fixes": [],
  "skipped_fixes": [],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": true,
  "review_required_reasons": [
    "MIXED_RGB_CMYK"
  ],
  "production_certified": false,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:28.124Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692987877-192",
  "changes": [],
  "boxes_changed": [],
  "color_converted": false,
  "interactive_removed": false,
  "skipped_fixes": [],
  "visual_review_required": true,
  "color_governance": {
    "highest_color_risk": "HIGH",
    "destructive_color_fix_applied": false,
    "unsupported_color_fixes": [],
    "review_required_color_reasons": [
      "MIXED_RGB_CMYK"
    ],
    "production_certified": false,
    "certified_pdf_allowed": false
  }
}
```

## Scenario H: Findings never applied
**Status:** ✅ PASS

### Audit Result
```json
{
  "version": "2.0",
  "job_id": "job-52b-1780692988127-719",
  "parent_job_id": null,
  "source_pdf": "C:\\Users\\KIKE\\AppData\\Local\\Temp\\phase52b-1780692986420\\test.pdf",
  "engine_version": "2.5.0",
  "policy_mode": "REVIEW_REQUIRED",
  "requested_fixes": [
    "RICH_BLACK_TEXT"
  ],
  "applied_fixes": [],
  "skipped_fixes": [],
  "failed_fixes": [],
  "fix_results": [],
  "review_required": true,
  "review_required_reasons": [
    "RICH_BLACK_TEXT"
  ],
  "production_certified": false,
  "artifact_policy": {
    "fixed_pdf": false,
    "review_pdf": false,
    "certified_pdf": false,
    "delta_report": true
  },
  "toolchain": {
    "qpdf": {
      "available": false,
      "version": null
    },
    "ghostscript": {
      "available": true,
      "version": "10.06.0"
    }
  },
  "created_at": "2026-06-05T20:56:28.363Z"
}
```

### Delta Result
```json
{
  "job_id": "job-52b-1780692988127-719",
  "changes": [],
  "boxes_changed": [],
  "color_converted": false,
  "interactive_removed": false,
  "skipped_fixes": [],
  "visual_review_required": true,
  "color_governance": {
    "highest_color_risk": "HIGH",
    "destructive_color_fix_applied": false,
    "unsupported_color_fixes": [],
    "review_required_color_reasons": [
      "RICH_BLACK_TEXT"
    ],
    "production_certified": false,
    "certified_pdf_allowed": false
  }
}
```

