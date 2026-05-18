const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../processors/AnalyzeProcessor.js');
let content = fs.readFileSync(targetFile, 'utf8');

// Replacement 1: Add helper function collectAndDeduplicateFindings
const t1 = `// Canonical storage instance
const storage = new StorageManager();

class AnalyzeProcessor {`;

const r1 = `// Canonical storage instance
const storage = new StorageManager();

function collectAndDeduplicateFindings(report) {
    if (!report) return [];
    
    const list = [];
    const addAll = (arr) => {
        if (Array.isArray(arr)) {
            list.push(...arr);
        }
    };

    addAll(report.findings);
    addAll(report.issues);
    if (report.analysis) {
        addAll(report.analysis.findings);
        addAll(report.analysis.issues);
    }
    if (report.forensics) {
        addAll(report.forensics.findings);
    }

    const unique = [];
    const seenIds = new Set();
    const seenCompositeKeys = new Set();

    for (const f of list) {
        if (!f) continue;
        
        const id = f.id;
        const code = f.code || '';
        const page = f.page !== undefined && f.page !== null ? String(f.page) : '';
        const severity = (f.severity || '').toLowerCase();
        const message = f.message || '';
        
        if (id !== undefined && id !== null && id !== '') {
            if (!seenIds.has(id)) {
                seenIds.add(id);
                unique.push(f);
            }
        } else {
            const composite = \`\${code}|\${page}|\${severity}|\${message}\`;
            if (!seenCompositeKeys.has(composite)) {
                seenCompositeKeys.add(composite);
                unique.push(f);
            }
        }
    }
    
    return unique;
}

class AnalyzeProcessor {`;

// Replacement 2: Update findings collection, classifier call, and shouldCertify
const t2 = `        // Canonical Phase 10 Result Classification
        const classifier = classifyEngineResult(report);
        const findings = report?.findings || report?.issues || [];
        const warnings = report?.warnings || [];
        const analyzerCoverage = report?.analyzerCoverage || report?.analyzer_coverage || {};
        const analyzer_coverage = report?.analyzer_coverage || report?.analyzerCoverage || {};
        const analysisIntegrity = report?.analysisIntegrity || {};
        const summary = report?.summary || {};

        const hasBlockingFindings = findings.some(f => {
            const sev = (f.severity || '').toLowerCase();
            return sev === 'critical' || sev === 'error';
        });

        // Gating certification based on findings severity and report certifiability
        const shouldCertify = (
            classifier !== 'FULL_ENVIRONMENT_FAILURE' &&
            classifier !== 'DOCUMENT_FAILURE' &&
            report?.certifiable !== false &&
            analysisIntegrity?.certifiable !== false &&
            !hasBlockingFindings
        );`;

const r2 = `        // Collect findings from all possible locations and deduplicate
        const findings = collectAndDeduplicateFindings(report);

        // Enrich report with the unified findings so that the classifier works on all findings
        const enrichedReportForClassifier = {
            ...report,
            findings,
            issues: findings
        };

        // Canonical Phase 10 Result Classification
        const classifier = classifyEngineResult(enrichedReportForClassifier);
        
        const warnings = report?.warnings || [];
        const analyzerCoverage = report?.analyzerCoverage || report?.analyzer_coverage || {};
        const analyzer_coverage = report?.analyzer_coverage || report?.analyzerCoverage || {};
        const analysisIntegrity = report?.analysisIntegrity || {};
        const summary = report?.summary || {};

        const hasBlockingFindings = findings.some(f => {
            const sev = (f.severity || '').toLowerCase();
            return sev === 'critical' || sev === 'error';
        });

        // Gating certification based on findings severity and report certifiability
        const shouldCertify = (
            classifier !== 'FULL_ENVIRONMENT_FAILURE' &&
            classifier !== 'DOCUMENT_FAILURE' &&
            report?.certifiable !== false &&
            analysisIntegrity?.certifiable !== false &&
            !hasBlockingFindings
        );`;

const checkAndReplace = (target, replacement, label) => {
    if (content.includes(target)) {
        content = content.replace(target, replacement);
        console.log(`[REPLACE] ${label} - Success`);
    } else {
        const normTarget = target.replace(/\r\n/g, '\n');
        const normContent = content.replace(/\r\n/g, '\n');
        if (normContent.includes(normTarget)) {
            content = normContent.replace(normTarget, replacement.replace(/\r\n/g, '\n'));
            console.log(`[REPLACE] ${label} (normalized endings) - Success`);
        } else {
            console.error(`[REPLACE] ${label} - Target not found!`);
        }
    }
};

checkAndReplace(t1, r1, "Block 1: collectAndDeduplicateFindings definition");
checkAndReplace(t2, r2, "Block 2: findings merging & classification call");

fs.writeFileSync(targetFile, content, 'utf8');
console.log('Update complete.');
