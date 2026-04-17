/**
 * Hardened Validation Test
 * Verifies Phase 10 Artifact registration and contract compliance.
 */

// 1. Setup Dynamic Mocks
let engineResponse = {
    analyze: { issues: [{ id: 'TEST', message: 'test' }] },
    autofix: { fixedPath: '/tmp/fixed.pdf' }
};

const MockDb = {
    execute: async () => [{}],
    lastJobResult: null,
    lastEvidence: null
};

const fsMock = {
    config: () => ({}),
    existsSync: () => true,
    pathExists: async () => true,
    copy: async () => {},
    ensureDir: async () => {},
    ensureDirSync: () => {},
    move: async () => {},
    remove: async () => {},
    statSync: () => ({ size: 1000 })
};

const MockEngine = {
    createStandardEngine: () => ({
        analyzePdf: async () => engineResponse.analyze,
        autofixPdf: async () => engineResponse.autofix
    })
};

// Override Module Loader
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === '@ppos/shared-infra/packages/data/db') return MockDb;
    if (request === '@ppos/preflight-engine') return MockEngine;
    if (request === 'fs-extra') return fsMock;
    if (request === 'pino') return () => ({ info: () => {}, error: () => {}, warn: () => {}, child: () => ({ info: () => {}, error: () => {} }) });
    if (request === 'bullmq' || request === 'ioredis' || request === 'dotenv' || request === 'uuid') {
        return { config: () => ({}), v4: () => 'uuid-v4' };
    }
    if (request === '../utils/StorageManager') {
        return class {
            verifyPathIsolation() { return true; }
            getJobSubfolder(t, j, f) { return `/tmp/storage/${t}/jobs/${j}/${f}`; }
        };
    }
    return originalLoad.apply(this, arguments);
};

const JobRouter = require('./queue/JobRouter');

async function validate() {
    console.log('--- STARTING HARDENED WORKER VALIDATION ---\n');

    const logger = { info: () => {}, error: () => {}, child: () => ({ info: () => {}, error: () => {} }) };

    // --- TEST 1: ANALYZE ---
    console.log('STEP 1: Testing ANALYZE canonical registration...');
    const analyzeJob = {
        name: 'ANALYZE',
        data: { jobId: 'job_1', tenantId: 'tenant_1', input: { fileUrl: '/tmp/in.pdf' } },
        updateProgress: async () => {}
    };
    
    const analyzeResult = await JobRouter.route(analyzeJob, logger);
    console.log('Analyze Result Artifacts:', analyzeResult.artifacts);
    if (analyzeResult.artifacts.certified_pdf !== 'certified.pdf') throw new Error('Analyze artifact registration failed');

    // --- TEST 2: AUTOFIX ---
    console.log('\nSTEP 2: Testing AUTOFIX deterministic resolution...');
    const autofixJob = {
        name: 'AUTOFIX',
        data: { jobId: 'fix_1', tenantId: 'tenant_1', input: { fileUrl: '/tmp/in.pdf' } },
        updateProgress: async () => {}
    };

    engineResponse.autofix = { fixedPath: '/tmp/engine_out.pdf' };
    const autofixResult = await JobRouter.route(autofixJob, logger);
    console.log('Autofix Result Artifacts:', autofixResult.artifacts);
    if (autofixResult.artifacts.fixed_pdf !== 'fixed.pdf' || autofixResult.artifacts.certified_pdf !== 'certified.pdf') {
        throw new Error('Autofix artifact registration failed');
    }

    // --- TEST 3: AUTOFIX FAILURE ---
    console.log('\nSTEP 3: Testing AUTOFIX explicit failure on missing output...');
    fsMock.pathExists = async () => false;
    try {
        await JobRouter.route(autofixJob, logger);
        throw new Error('Should have failed but succeeded');
    } catch (e) {
        if (e.message.includes('[AUTOFIX-FAILURE]')) {
            console.log('Confirmed: Threw expected failure:', e.message);
        } else {
            throw e;
        }
    }

    console.log('\n--- ALL VALIDATIONS PASSED ---');
}

validate().catch(err => {
    console.error('\nVALIDATION FAILED');
    console.error(err);
    process.exit(1);
});
