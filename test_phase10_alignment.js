/**
 * test_phase10_alignment.js
 * 
 * Comprehensive regression and validation suite verifying Phase 10 compliance:
 * - Metadata preservation (non-destructive analysisIntegrity)
 * - Canonical classification mapping
 * - Gated certification (promotes certified.pdf only when certifiable)
 * - Report.json write and registration
 * - Direct database status, progress, and result persistence
 * - Non-retryable error handling (RetryPolicy + QueueManager attempts control)
 */

const assert = require('assert');
const path = require('path');

// 1. Captured State Mocks
let lastDbQuery = null;
let lastDbParams = null;
let lastEngineOptions = null;
let engineResponse = {
    status: 'SUCCESS',
    analysisIntegrity: { realExtraction: true },
    findings: [],
    summary: { risk_score: 100 },
    analyzerCoverage: { full: true }
};

const MockDb = {
    execute: async (query, params) => {
        lastDbQuery = query;
        lastDbParams = params;
        return [{}];
    }
};

const fsMock = {
    config: () => ({}),
    existsSync: () => true,
    pathExists: async () => true,
    copy: async () => { },
    ensureDir: async () => { },
    ensureDirSync: () => { },
    move: async () => { },
    remove: async () => { },
    stat: async () => ({ size: 1024 }),
    statSync: () => ({ size: 1024 }),
    writeJson: async () => { },
    writeJsonSync: () => { }
};

const MockEngine = {
    createStandardEngine: () => ({
        analyzePdf: async (filePath, options) => {
            lastEngineOptions = options;
            return engineResponse;
        }
    })
};

// 2. Override Module Loader
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '@ppos/shared-infra/packages/data/db') return MockDb;
    if (request === '@ppos/preflight-engine') return MockEngine;
    if (request === 'fs-extra') return fsMock;
    if (request === '../utils/StorageManager') {
        return class {
            verifyPathIsolation() { return true; }
            getJobSubfolder(t, j, f) { return `/tmp/storage/${t}/jobs/${j}/${f}`; }
        };
    }
    if (request === 'pino') {
        return () => ({
            info: () => { },
            error: () => { },
            warn: () => { },
            debug: () => { },
            child: () => ({
                info: () => { },
                error: () => { },
                warn: () => { },
                debug: () => { }
            })
        });
    }
    if (request === 'bullmq' || request === 'ioredis' || request === 'dotenv' || request === 'uuid') {
        return { config: () => ({}), v4: () => 'uuid-v4' };
    }
    return originalLoad.apply(this, arguments);
};

// 3. Load Modules Under Test
const JobRouter = require('./queue/JobRouter');
const RetryPolicy = require('./queue/RetryPolicy');
const classifyEngineResult = require('./utils/classifyEngineResult');

async function runPhase10Tests() {
    console.log('================================================================');
    console.log('RUNNING PHASE 10 ALIGNMENT REGRESSION SUITE');
    console.log('================================================================\n');

    const logger = console;

    // ---------------------------------------------------------
    // TEST 1: Canonical Classification Mapping
    // ---------------------------------------------------------
    console.log('TEST 1: Canonical Classification Mapping');

    // Test FULL_ENVIRONMENT_FAILURE
    const c1 = classifyEngineResult({
        status: 'FAILED_RUNTIME_ENVIRONMENT',
        analysisIntegrity: { realExtraction: false }
    });
    assert.strictEqual(c1, 'FULL_ENVIRONMENT_FAILURE', 'Should classify as FULL_ENVIRONMENT_FAILURE');

    // Test DEGRADED_ANALYSIS
    const c2 = classifyEngineResult({
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true, degradedMode: true, missingTools: ['mutool'] },
        findings: [{ id: 'F1', severity: 'warning' }]
    });
    assert.strictEqual(c2, 'DEGRADED_ANALYSIS', 'Should classify as DEGRADED_ANALYSIS');

    // Test PARTIAL_ANALYSIS
    const c3 = classifyEngineResult({
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        analyzerCoverage: { partial: ['text'] },
        findings: []
    });
    assert.strictEqual(c3, 'PARTIAL_ANALYSIS', 'Should classify as PARTIAL_ANALYSIS');

    // Test DOCUMENT_FAILURE (critical/error findings)
    const c4 = classifyEngineResult({
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        findings: [{ id: 'F1', severity: 'error' }]
    });
    assert.strictEqual(c4, 'DOCUMENT_FAILURE', 'Should classify as DOCUMENT_FAILURE');

    // Test SUCCESS_WITH_FINDINGS (only warning/info findings)
    const c5 = classifyEngineResult({
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        findings: [{ id: 'F1', severity: 'warning' }]
    });
    assert.strictEqual(c5, 'SUCCESS_WITH_FINDINGS', 'Should classify as SUCCESS_WITH_FINDINGS');

    // Test SUCCESS (no findings)
    const c6 = classifyEngineResult({
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        findings: []
    });
    assert.strictEqual(c6, 'SUCCESS', 'Should classify as SUCCESS');

    console.log('✔ Test 1 Passed: Correctly classified all engine output profiles.\n');

    // ---------------------------------------------------------
    // TEST 2: Non-Destructive Metadata Preservation
    // ---------------------------------------------------------
    console.log('TEST 2: Non-Destructive Metadata Preservation');
    engineResponse = {
        status: 'SUCCESS',
        analysis_type: 'REAL_INDUSTRIAL',
        analysisIntegrity: {
            realExtraction: true,
            fallbackUsed: false,
            missingTools: ['mutool']
        },
        findings: [],
        summary: { risk_score: 95 }
    };

    const job = {
        name: 'ANALYZE',
        data: { jobId: 'job_preservation', tenantId: 'tenant_preservation', input: { fileUrl: '/tmp/test.pdf' } },
        updateProgress: async () => { }
    };

    const res = await JobRouter.route(job, logger);

    // Assert realExtraction was NOT overwritten
    assert.strictEqual(res.analysisIntegrity.realExtraction, true, 'realExtraction should remain true');
    assert.strictEqual(res.analysisIntegrity.fallbackUsed, false, 'fallbackUsed should remain false');
    // Assert worker metadata was non-destructively added
    assert.deepStrictEqual(res.analysisIntegrity.workerObservedMissingTools, ['mutool'], 'Should record missing tools');
    assert.strictEqual(res.analysisIntegrity.workerDegradedMode, true, 'Should flag workerDegradedMode');

    console.log('✔ Test 2 Passed: Preserved critical engine extraction indicators non-destructively.\n');

    // ---------------------------------------------------------
    // TEST 3: Gated Certification (Skip certified.pdf)
    // ---------------------------------------------------------
    console.log('TEST 3: Gated Certification Gating rules');

    // Case A: Has critical finding (Document Failure)
    engineResponse = {
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        findings: [{ id: 'F1', severity: 'error', message: 'Low resolution image' }],
        summary: { risk_score: 50 }
    };

    const resA = await JobRouter.route(job, logger);
    assert.strictEqual(resA.artifacts.certified_pdf, undefined, 'Should NOT promote certified.pdf on blocking severity findings');
    assert.strictEqual(resA.artifacts.analysis_report, 'report.json', 'Should always include report.json');
    assert.strictEqual(resA.status, 'COMPLETED_WITH_FINDINGS', 'Should set status to COMPLETED_WITH_FINDINGS');

    // Case B: Explicitly flagged as not certifiable
    engineResponse = {
        status: 'SUCCESS',
        certifiable: false,
        analysisIntegrity: { realExtraction: true },
        findings: [],
        summary: { risk_score: 100 }
    };

    const resB = await JobRouter.route(job, logger);
    assert.strictEqual(resB.artifacts.certified_pdf, undefined, 'Should NOT promote certified.pdf when certifiable is false');
    assert.strictEqual(resB.status, 'COMPLETED', 'Should set status to COMPLETED');

    console.log('✔ Test 3 Passed: Successfully gated certified.pdf promotion based on quality markers.\n');

    // ---------------------------------------------------------
    // TEST 4: Direct Database Status & Progress Persistence
    // ---------------------------------------------------------
    console.log('TEST 4: Direct Database Updates');
    lastDbQuery = null;
    lastDbParams = null;

    engineResponse = {
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        findings: [],
        summary: { risk_score: 100 }
    };

    await JobRouter.route(job, logger);

    assert.ok(lastDbQuery.includes('UPDATE jobs SET status = ?, result = ?'), 'Should execute UPDATE jobs query');
    assert.strictEqual(lastDbParams[0], 'COMPLETED', 'First param should be job completion status');
    assert.strictEqual(lastDbParams[2], 'job_preservation', 'Third param should be jobId');
    assert.strictEqual(lastDbParams[3], 'tenant_preservation', 'Fourth param should be tenantId');

    console.log('✔ Test 4 Passed: Direct MySQL database updates validated successfully.\n');

    // ---------------------------------------------------------
    // TEST 5: Non-Retryable Error Handlers
    // ---------------------------------------------------------
    console.log('TEST 5: Non-Retryable Error Classification');

    const err1 = new Error('[ANALYZE-CONTRACT-ERROR] jobId=1 Missing input file reference');
    const err2 = new Error('Some database connection timeout');
    const err3 = new Error('isolation breach occurred');

    assert.strictEqual(RetryPolicy.shouldRetry(err1), false, 'ANALYZE-CONTRACT-ERROR should be fatal (no retry)');
    assert.strictEqual(RetryPolicy.shouldRetry(err2), true, 'Network timeout error should be retried');
    assert.strictEqual(RetryPolicy.shouldRetry(err3), false, 'Isolation breach error should be fatal (no retry)');

    console.log('✔ Test 5 Passed: Retry policy correctly classified fatal vs. transient failures.\n');

    // ---------------------------------------------------------
    // TEST 6: Hardened Classification, Merging, and Gating Scenarios
    // ---------------------------------------------------------
    console.log('TEST 6: Hardened Classification, Merging, and Gating Scenarios');

    // Scenario A: realExtraction=false + missing_tools + no findings/summary/coverage => FULL_ENVIRONMENT_FAILURE
    const cA = classifyEngineResult({
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: false, missingTools: ['mutool'] },
        findings: [],
        summary: {},
        analyzerCoverage: {}
    });
    assert.strictEqual(cA, 'FULL_ENVIRONMENT_FAILURE', 'Should be FULL_ENVIRONMENT_FAILURE because summary and analyzerCoverage are empty');

    // Scenario B: realExtraction=true + missing_tools + findings => DEGRADED_ANALYSIS
    const cB = classifyEngineResult({
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true, missingTools: ['mutool'] },
        findings: [{ id: 'F1', severity: 'warning' }]
    });
    assert.strictEqual(cB, 'DEGRADED_ANALYSIS', 'Should be DEGRADED_ANALYSIS because we have realExtraction and findings');

    // Scenario C: findings spread across multiple locations are merged and deduplicated
    engineResponse = {
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        findings: [
            { id: '1', severity: 'warning', message: 'Unique finding 1' },
            { severity: 'warning', code: 'W001', page: 1, message: 'Unique finding 2' }
        ],
        issues: [
            { id: '1', severity: 'warning', message: 'Duplicate finding 1 by ID' }
        ],
        analysis: {
            findings: [
                { severity: 'warning', code: 'W001', page: 1, message: 'Unique finding 2' }
            ],
            issues: [
                { id: '3', severity: 'critical', message: 'Blocking finding in analysis' }
            ]
        },
        forensics: {
            findings: [
                { id: '4', severity: 'info', message: 'Forensics info finding' }
            ]
        }
    };

    const jobC = {
        name: 'ANALYZE',
        data: { jobId: 'job_merging', tenantId: 'tenant_preservation', input: { fileUrl: '/tmp/test.pdf' } },
        updateProgress: async () => { }
    };

    const resC = await JobRouter.route(jobC, logger);

    assert.strictEqual(resC.findings.length, 4, 'Should merge and deduplicate to exactly 4 findings');
    const ids = resC.findings.map(f => f.id).filter(Boolean);
    assert.ok(ids.includes('1'), 'Should contain finding 1');
    assert.ok(ids.includes('3'), 'Should contain finding 3');
    assert.ok(ids.includes('4'), 'Should contain finding 4');

    // Scenario D: blocking finding in analysis.findings prevents certified.pdf
    assert.strictEqual(resC.artifacts.certified_pdf, undefined, 'Blocking finding should prevent certified.pdf promotion');
    assert.strictEqual(resC.status, 'COMPLETED_WITH_FINDINGS', 'Should classify final status as COMPLETED_WITH_FINDINGS');

    // Scenario E: warning finding in forensics.findings produces COMPLETED_WITH_FINDINGS or equivalent
    engineResponse = {
        status: 'SUCCESS',
        analysisIntegrity: { realExtraction: true },
        forensics: {
            findings: [
                { id: '5', severity: 'warning', message: 'Forensics warning finding' }
            ]
        }
    };

    const resE = await JobRouter.route(jobC, logger);
    assert.strictEqual(resE.status, 'COMPLETED_WITH_FINDINGS', 'Should set status to COMPLETED_WITH_FINDINGS for warning in forensics');
    assert.strictEqual(resE.artifacts.certified_pdf, 'certified.pdf', 'Warning severity should not block certified.pdf promotion');

    console.log('✔ Test 6 Passed: Merged, deduplicated, and gated all scenarios correctly.\n');

    console.log('================================================================');
    console.log('✔ ALL PHASE 10 ALIGNMENT REGRESSION TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================');
}

runPhase10Tests().catch(err => {
    console.error('TEST SUITE FAILED:', err);
    process.exit(1);
});
