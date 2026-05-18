/**
 * utils/classifyEngineResult.js
 * 
 * Classifies an Engine Preflight report into canonical Phase 10 categories:
 * - FULL_ENVIRONMENT_FAILURE
 * - DEGRADED_ANALYSIS
 * - PARTIAL_ANALYSIS
 * - DOCUMENT_FAILURE
 * - SUCCESS_WITH_FINDINGS
 * - SUCCESS
 */

function classifyEngineResult(report) {
    if (!report) {
        return 'FULL_ENVIRONMENT_FAILURE';
    }

    const status = report.status || report.analysis_status;
    const analysisIntegrity = report.analysisIntegrity || {};
    const realExtraction = analysisIntegrity.realExtraction;
    const degradedMode = analysisIntegrity.degradedMode;
    const missingTools = report.missing_tools || report.missingTools || analysisIntegrity.missingTools || [];
    const findings = report.findings || report.issues || [];

    // Explicit Phase 10 Hardened Helpers
    const hasSummary = (summary) => {
        return summary && typeof summary === 'object' && Object.keys(summary).length > 0;
    };

    const hasCoverage = (coverage) => {
        return coverage && typeof coverage === 'object' && Object.keys(coverage).length > 0;
    };

    const hasFindings = (f) => {
        return Array.isArray(f) && f.length > 0;
    };

    const usable = hasFindings(findings) || hasSummary(report.summary) || hasCoverage(report.analyzerCoverage) || hasCoverage(report.analyzer_coverage);

    // 1. FULL_ENVIRONMENT_FAILURE
    if (
        status === 'FAILED_RUNTIME_ENVIRONMENT' ||
        (realExtraction === false && !usable)
    ) {
        return 'FULL_ENVIRONMENT_FAILURE';
    }

    // 2. DEGRADED_ANALYSIS
    const hasMissingTools = Array.isArray(missingTools) && missingTools.length > 0;
    if (hasMissingTools || degradedMode === true || report.analysis_type === 'DEGRADED') {
        // Degraded applies only if we have a usable result OR if realExtraction !== false
        if (usable || realExtraction !== false) {
            return 'DEGRADED_ANALYSIS';
        }
    }

    // 3. PARTIAL_ANALYSIS
    const analyzerCoverage = report.analyzerCoverage || report.analyzer_coverage || {};
    const hasPartial = (analyzerCoverage.partial && (Array.isArray(analyzerCoverage.partial) ? analyzerCoverage.partial.length > 0 : Object.keys(analyzerCoverage.partial).length > 0)) ||
                        (analyzerCoverage.skipped && (Array.isArray(analyzerCoverage.skipped) ? analyzerCoverage.skipped.length > 0 : Object.keys(analyzerCoverage.skipped).length > 0));
    if (hasPartial) {
        return 'PARTIAL_ANALYSIS';
    }

    // 4. DOCUMENT_FAILURE
    const hasCriticalOrError = findings.some(f => {
        const severity = (f.severity || '').toLowerCase();
        return severity === 'critical' || severity === 'error';
    });
    if (hasCriticalOrError) {
        return 'DOCUMENT_FAILURE';
    }

    // 5. SUCCESS_WITH_FINDINGS
    if (hasFindings(findings)) {
        return 'SUCCESS_WITH_FINDINGS';
    }

    // 6. SUCCESS
    return 'SUCCESS';
}

module.exports = classifyEngineResult;
