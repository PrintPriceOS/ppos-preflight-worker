/**
 * Smoke Test: Preflight Worker Real Fixed PDF Artifact Materialization
 * Validates Phase 42A requirements for physical artifact production, 0-byte blocking, and correct metadata.
 */

const assert = require('assert');
const path = require('path');

const logHistory = [];
const customLogger = {
    info: (meta, msg) => logHistory.push({ level: 'info', meta, msg }),
    warn: (meta, msg) => logHistory.push({ level: 'warn', meta, msg }),
    error: (meta, msg) => logHistory.push({ level: 'error', meta, msg }),
    debug: (meta, msg) => logHistory.push({ level: 'debug', meta, msg })
};

let mockedEngineResult = {};
let mockFileSize = 1024; // Default to a valid file size
let mockFiles = new Set(); // Files currently "on disk"

const fsMock = {
    config: () => ({}),
    existsSync: (p) => true,
    pathExists: async (p) => true,
    copy: async (src, dest) => {
        mockFiles.add(dest);
    },
    ensureDir: async () => {},
    ensureDirSync: () => {},
    move: async () => {},
    remove: async () => {},
    stat: async (p) => {
        // If file is fixed.pdf or certified.pdf, return mockFileSize
        // For fix_audit.json, return fixed size
        if (p.endsWith('fix_audit.json')) return { size: 500 };
        return { size: mockFileSize };
    },
    statSync: () => ({ size: mockFileSize }),
    writeJson: async (p, data) => {
        mockFiles.add(p);
    },
    writeJsonSync: () => {}
};

const MockEngine = {
    createStandardEngine: () => ({
        analyzePdf: async () => ({}),
        autofixPdf: async (input, payload) => {
            return mockedEngineResult;
        }
    })
};

const MockDb = {
    execute: async () => [{}],
    lastJobResult: null,
    lastEvidence: null
};

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

process.env.CONTROL_PLANE_URL = 'http://localhost:9999';
process.env.PPOS_CONTROL_TOKEN = 'mock-token';

const AutofixProcessor = require('../processors/AutofixProcessor');

async function runSmokeTest() {
    console.log('================================================================');
    console.log('RUNNING SMOKE TEST: ARTIFACT MATERIALIZATION (PHASE 42A)');
    console.log('================================================================\n');

    const testFileUrl = path.resolve(__dirname, 'dummy_input.pdf');

    // Helper to get basic job data
    const getJobPayload = (jobId) => ({
        data: {
            jobId,
            tenantId: 'tenant_test',
            fixes: ['APPLY_BLEED'],
            input: { fileUrl: testFileUrl },
            findings: [{ code: 'TRIMBOX_MISSING', severity: 'error' }]
        }
    });

    // --- CASE A: Successful AUTOFIX with output PDF ---
    console.log('CASE A: Successful AUTOFIX with output PDF');
    logHistory.length = 0;
    mockFiles.clear();
    mockFileSize = 1024; // > 0
    mockedEngineResult = {
        fixedPath: '/tmp/fixed.pdf',
        repairs: [{ code: 'APPLY_BLEED', status: 'APPLIED' }]
    };

    const resultA = await AutofixProcessor.process(getJobPayload('jobA'), customLogger);

    assert(resultA.physical_artifacts_ready !== false, 'Physical artifacts should be ready');
    assert.strictEqual(resultA.artifacts.fixed_pdf, 'fixed.pdf');
    assert.strictEqual(resultA.artifacts.fix_audit, 'fix_audit.json');
    assert(!resultA.artifacts.review_pdf, 'review_pdf should not exist for fully applied repairs');

    const blockedLogA = logHistory.find(l => l.msg === '[PREFLIGHT-WORKER][ZERO_BYTE_ARTIFACT_BLOCKED]');
    assert(!blockedLogA, 'Should not emit ZERO_BYTE_ARTIFACT_BLOCKED');
    const completeLogA = logHistory.find(l => l.msg === '[PREFLIGHT-WORKER][AUTOFIX_COMPLETE]');
    assert(completeLogA, 'Should emit AUTOFIX_COMPLETE');
    assert(completeLogA.meta.zero_byte_artifact_count === 0, 'Zero byte artifact count should be 0');
    console.log('✔ Case A Passed: Standard PDF materialized and audit stored.\n');


    // --- CASE B: REVIEW_REQUIRED with one output PDF ---
    console.log('CASE B: REVIEW_REQUIRED with one output PDF');
    logHistory.length = 0;
    mockFiles.clear();
    mockFileSize = 2048; // > 0
    mockedEngineResult = {
        fixedPath: '/tmp/fixed.pdf',
        status: 'REVIEW_REQUIRED',
        repairs: [
            { code: 'APPLY_BLEED', status: 'APPLIED' },
            { code: 'REBUILD_TRIMBOX', status: 'FAILED' }
        ]
    };

    const resultB = await AutofixProcessor.process(getJobPayload('jobB'), customLogger);

    assert(resultB.physical_artifacts_ready !== false);
    assert.strictEqual(resultB.artifacts.fixed_pdf, 'fixed.pdf');
    assert.strictEqual(resultB.artifacts.review_pdf, 'fixed.pdf', 'review_pdf should alias to the fixed.pdf');
    assert.strictEqual(resultB.artifacts.fix_audit, 'fix_audit.json');
    console.log('✔ Case B Passed: REVIEW_REQUIRED exposes fixed_pdf and review_pdf aliases correctly.\n');


    // --- CASE D: Zero-byte output scenario ---
    console.log('CASE D: Zero-byte output scenario');
    logHistory.length = 0;
    mockFiles.clear();
    mockFileSize = 0; // 0 byte file
    mockedEngineResult = {
        fixedPath: '/tmp/fixed.pdf',
        repairs: [{ code: 'APPLY_BLEED', status: 'APPLIED' }]
    };

    const resultD = await AutofixProcessor.process(getJobPayload('jobD'), customLogger);

    assert.strictEqual(resultD.physical_artifacts_ready, false);
    assert.strictEqual(resultD.artifact_error, 'NO_FIXED_PDF_BYTES_PRODUCED');
    assert.strictEqual(resultD.artifacts.length, 0); // No artifacts when totally failed
    
    const blockedLogD = logHistory.filter(l => l.msg === '[PREFLIGHT-WORKER][ZERO_BYTE_ARTIFACT_BLOCKED]');
    assert(blockedLogD.length > 0, 'Should emit ZERO_BYTE_ARTIFACT_BLOCKED');
    console.log('✔ Case D Passed: Zero-byte output was properly blocked and NO_FIXED_PDF_BYTES_PRODUCED returned.\n');

    // --- CASE C: No output PDF possible (No source file given by engine) ---
    console.log('CASE C: No output PDF possible');
    logHistory.length = 0;
    mockFiles.clear();
    mockFileSize = 1024;
    mockedEngineResult = {
        fixedPath: null, // engine returned nothing
        repairs: []
    };
    
    // Also override fsMock.pathExists so legacy fallback / structured paths fail
    const oldPathExists = fsMock.pathExists;
    fsMock.pathExists = async (p) => {
        if (p.includes('dummy_input.pdf')) return true;
        if (p.includes('fix_audit.json')) return true; // audit always generated
        return false;
    };

    const resultC = await AutofixProcessor.process(getJobPayload('jobC'), customLogger);
    fsMock.pathExists = oldPathExists;

    assert.strictEqual(resultC.physical_artifacts_ready, false);
    assert.strictEqual(resultC.artifact_error, 'NO_FIXED_PDF_BYTES_PRODUCED');
    
    // Check that fix_audit was still generated and registered (downloadable_artifact_count should be 1)
    const completeLogC = logHistory.find(l => l.msg === '[PREFLIGHT-WORKER][AUTOFIX_COMPLETE]');
    assert(completeLogC.meta.downloadable_artifact_count === 1, 'Audit should be downloadable even if PDF fails');
    console.log('✔ Case C Passed: Missing engine output correctly triggers NO_FIXED_PDF_BYTES_PRODUCED.\n');


    console.log('================================================================');
    console.log('✔ ALL SMOKE TESTS EXECUTED SUCCESSFULLY!');
    console.log('================================================================');
}

runSmokeTest().catch(err => {
    console.error('❌ Smoke test failed:', err);
    process.exit(1);
});
