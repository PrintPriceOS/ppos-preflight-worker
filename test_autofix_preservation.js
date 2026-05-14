/**
 * Regression Test Suite: Preserve AUTOFIX intent and engine repair results end-to-end
 * Validates Phase 10 Autofix repair integrity and contract compliance.
 */

const assert = require('assert');
const path = require('path');

// Capture structured logs emitted during processing
const logHistory = [];
const customLogger = {
    info: (meta, msg) => {
        logHistory.push({ level: 'info', meta, msg });
    },
    warn: (meta, msg) => {
        logHistory.push({ level: 'warn', meta, msg });
    },
    error: (meta, msg) => {
        logHistory.push({ level: 'error', meta, msg });
    }
};

let lastEnginePayload = null;
let mockedEngineResult = {};

const fsMock = {
    config: () => ({}),
    existsSync: () => true,
    pathExists: async (p) => {
        if (typeof p === 'string' && (p.includes('.pdf') || p.includes('.json'))) {
            return true;
        }
        return false;
    },
    copy: async () => {},
    ensureDir: async () => {},
    ensureDirSync: () => {},
    move: async () => {},
    remove: async () => {},
    stat: async () => ({ size: 1024 }),
    statSync: () => ({ size: 1024 })
};

const MockEngine = {
    createStandardEngine: () => ({
        analyzePdf: async () => ({}),
        autofixPdf: async (input, payload) => {
            lastEnginePayload = payload;
            return mockedEngineResult;
        }
    })
};

const MockDb = {
    execute: async () => [{}],
    lastJobResult: null,
    lastEvidence: null
};

// Override Module Loader to run perfectly without node_modules installed locally
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === '@ppos/shared-infra/packages/data/db') return MockDb;
    if (request === '@ppos/preflight-engine') return MockEngine;
    if (request === 'fs-extra') return fsMock;
    if (request === 'pino') return () => customLogger;
    if (request === 'bullmq' || request === 'ioredis' || request === 'dotenv' || request === 'uuid') {
        return { config: () => ({}), v4: () => 'uuid-v4' };
    }
    return originalLoad.apply(this, arguments);
};

// Force process.env vars for ControlPlaneArtifacts
process.env.CONTROL_PLANE_URL = 'http://localhost:9999';
process.env.PPOS_CONTROL_TOKEN = 'mock-token';

const AutofixProcessor = require('./processors/AutofixProcessor');

async function runRegressionTests() {
    console.log('================================================================');
    console.log('RUNNING REGRESSION SUITE: AUTOFIX INTENT & REPAIR PRESERVATION');
    console.log('================================================================\n');

    const testFileUrl = path.resolve(__dirname, 'dummy_input.pdf');

    // --- TEST 1: Worker forwards all requested fixes to Engine ---
    console.log('TEST 1: Worker forwards all requested fixes to Engine');
    logHistory.length = 0;
    lastEnginePayload = null;
    mockedEngineResult = {
        fixedPath: '/tmp/fixed.pdf',
        repairs: [
            { code: 'APPLY_BLEED', status: 'APPLIED' },
            { code: 'REBUILD_TRIMBOX', status: 'APPLIED' },
            { code: 'CONVERT_CMYK', status: 'APPLIED' },
            { code: 'INJECT_OUTPUT_INTENT', status: 'APPLIED' }
        ]
    };

    const jobPayload1 = {
        data: {
            jobId: 'job_test_1',
            tenantId: 'tenant_test',
            fixes: ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT'],
            forceBleed: true,
            targetProfile: 'FOGRA51',
            input: {
                fileUrl: testFileUrl
            },
            findings: [
                { code: 'TRIMBOX_MISSING', severity: 'error' },
                { code: 'BLEEDBOX_MISSING', severity: 'warning' }
            ]
        }
    };

    const result1 = await AutofixProcessor.process(jobPayload1, customLogger);

    // Assertions for Test 1
    assert(lastEnginePayload, 'Engine should have been called');
    assert.deepStrictEqual(lastEnginePayload.requested_fixes, ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT']);
    assert.deepStrictEqual(lastEnginePayload.fixes, ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT']);
    assert.strictEqual(lastEnginePayload.forceBleed, true);
    assert.strictEqual(lastEnginePayload.targetProfile, 'FOGRA51');
    assert.strictEqual(lastEnginePayload.findings.length, 2);
    console.log('✔ Test 1 Passed: Forwarded all requested fixes, forceBleed, targetProfile, and findings perfectly.\n');


    // --- TEST 2: Worker preserves Engine repairs ---
    console.log('TEST 2: Worker preserves Engine repairs');
    assert.strictEqual(result1.repairs.length, 4);
    assert.strictEqual(result1.fixes.length, 4);
    assert.deepStrictEqual(result1.applied_fixes.map(r => r.code), ['APPLY_BLEED', 'REBUILD_TRIMBOX', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT']);
    assert.strictEqual(result1.skipped_fixes.length, 0);
    assert.strictEqual(result1.failed_fixes.length, 0);
    
    // Check structured log emission
    const payloadInLog = logHistory.find(l => l.msg && l.msg.includes('[WORKER][AUTOFIX][PAYLOAD-IN]'));
    const engineCallLog = logHistory.find(l => l.msg && l.msg.includes('[WORKER][AUTOFIX][ENGINE-CALL]'));
    const engineResultLog = logHistory.find(l => l.msg && l.msg.includes('[WORKER][AUTOFIX][ENGINE-RESULT]'));
    const resultStoredLog = logHistory.find(l => l.msg && l.msg.includes('[WORKER][AUTOFIX][RESULT-STORED]'));

    assert(payloadInLog, 'Should emit PAYLOAD-IN structured log');
    assert(engineCallLog, 'Should emit ENGINE-CALL structured log');
    assert(engineResultLog, 'Should emit ENGINE-RESULT structured log');
    assert(resultStoredLog, 'Should emit RESULT-STORED structured log');
    console.log('✔ Test 2 Passed: Preserved complete Engine repair reports and verified lifecycle logging.\n');


    // --- TEST 3: Worker does not silently drop skipped fixes ---
    console.log('TEST 3: Worker does not silently drop skipped fixes');
    logHistory.length = 0;
    lastEnginePayload = null;
    mockedEngineResult = {
        fixedPath: '/tmp/fixed.pdf',
        repairs: [
            { code: 'APPLY_BLEED', status: 'APPLIED' },
            { code: 'CONVERT_CMYK', status: 'SKIPPED', reason: 'requires human review' },
            { code: 'INJECT_OUTPUT_INTENT', status: 'FAILED', reason: 'unsupported color profile' }
        ]
    };

    const jobPayload3 = {
        data: {
            jobId: 'job_test_3',
            tenantId: 'tenant_test',
            fixes: ['APPLY_BLEED', 'CONVERT_CMYK', 'INJECT_OUTPUT_INTENT'],
            input: {
                fileUrl: testFileUrl
            },
            findings: [{ code: 'IND_COLOR_001' }]
        }
    };

    const result3 = await AutofixProcessor.process(jobPayload3, customLogger);

    assert.strictEqual(result3.repairs.length, 3);
    assert.strictEqual(result3.applied_fixes.length, 1);
    assert.strictEqual(result3.skipped_fixes.length, 1);
    assert.strictEqual(result3.skipped_fixes[0].code, 'CONVERT_CMYK');
    assert.strictEqual(result3.skipped_fixes[0].reason, 'requires human review');
    assert.strictEqual(result3.failed_fixes.length, 1);
    assert.strictEqual(result3.failed_fixes[0].code, 'INJECT_OUTPUT_INTENT');
    console.log('✔ Test 3 Passed: Successfully exposed skipped and failed fixes without truncation.\n');


    // --- TEST 4: Missing source findings is explicit ---
    console.log('TEST 4: Missing source findings is explicit');
    logHistory.length = 0;
    lastEnginePayload = null;
    mockedEngineResult = {
        fixedPath: '/tmp/fixed.pdf',
        repairs: [
            { code: 'APPLY_BLEED', status: 'APPLIED' }
        ]
    };

    const jobPayload4 = {
        data: {
            jobId: 'job_test_4',
            tenantId: 'tenant_test',
            fixes: ['APPLY_BLEED'],
            input: {
                fileUrl: testFileUrl
            }
        }
    };

    const result4 = await AutofixProcessor.process(jobPayload4, customLogger);

    // Verify requested fixes still forwarded
    assert.deepStrictEqual(lastEnginePayload.requested_fixes, ['APPLY_BLEED']);
    
    // Verify degraded status and explicit reason
    assert.strictEqual(result4.status, 'DEGRADED');
    assert.strictEqual(result4.reason, 'MISSING_SOURCE_FINDINGS_FOR_AUTOFIX');

    // Verify logs capture the warning
    const missingFindingsLog = logHistory.find(l => l.msg && l.msg.includes('MISSING_SOURCE_FINDINGS_FOR_AUTOFIX'));
    assert(missingFindingsLog, 'Should log missing source findings explicitly');
    assert.strictEqual(missingFindingsLog.level, 'warn');
    console.log('✔ Test 4 Passed: Handled missing source findings with explicit warning and DEGRADED status.\n');

    console.log('================================================================');
    console.log('✔ ALL REGRESSION TESTS EXECUTED SUCCESSFULLY!');
    console.log('================================================================');
}

runRegressionTests().catch(err => {
    console.error('❌ Regression suite failed:', err);
    process.exit(1);
});
