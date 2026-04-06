/**
 * Patch Validation: Large PDF Async Analyze Contract
 * 
 * Final robust self-contained validation script.
 */

// 1. Setup Mocks BEFORE loading any app code
const MockDb = {
    execute: async (query, params) => {
        if (query.includes('UPDATE jobs')) {
            MockDb.lastJobResult = JSON.parse(params[2]);
        } else if (query.includes('INSERT INTO job_evidence')) {
            MockDb.lastEvidence = JSON.parse(params[4] || '{}').evidence;
        }
        return [{}];
    }
};

const MockEngine = {
    createStandardEngine: () => ({
        analyzePdf: async () => ({
            summary: { risk_score: 85, status: 'certified' },
            document: { page_count: 5, size_mb: 19.5, format: 'PDF/X-4' },
            engines: { pitstop: 'v2024', callas: 'v12' },
            issues: [
                { id: "IND_BLEED", message: "Missing bleed", severity: "error" },
                { id: "IND_COLOR", message: "RGB detected", severity: "warning" }
            ],
            metadata: { creator: 'Adobe InDesign', timestamp: new Date().toISOString() }
        })
    })
};

// Override Module Loader for mocks
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === '@ppos/shared-infra') return { db: MockDb };
    if (request === '@ppos/preflight-engine') return MockEngine;
    if (request === 'pino') return () => ({ info: () => {}, error: () => {}, warn: () => {}, child: () => ({ info: () => {}, error: () => {} }) });
    if (request === 'pino-pretty' || request === 'fs-extra' || request === 'bullmq' || request === 'ioredis' || request === 'dotenv' || request === 'uuid') {
        return { 
            config: () => ({}), 
            existsSync: () => true, 
            v4: () => 'uuid-v4', 
            ensureDir: async () => {},
            ensureDirSync: () => {},
            move: async () => {},
            remove: async () => {}
        };
    }
    // Mock StorageManager to avoid OS-specific path issues in validation
    if (request === '../utils/StorageManager') {
        return class {
            verifyPathIsolation() { return true; }
            getJobSubfolder() { return '/tmp/storage/job_456/output'; }
        };
    }
    return originalLoad.apply(this, arguments);
};

// 2. Load the patched modules
const JobRouter = require('./queue/JobRouter');

async function validate() {
    console.log('--- STARTING VALIDATION: LARGE PDF >5MB ANALYZE JOB ---\n');

    const mockJob = {
        id: '999',
        name: 'ANALYZE',
        data: {
            jobId: 'job_456',
            tenantId: 'tenant_123',
            payload: {
                filePath: '/tmp/large_test.pdf'
            }
        },
        updateProgress: async (p) => {}
    };

    const logger = { info: () => {}, error: () => {}, child: () => ({ info: () => {}, error: () => {} }) };

    // Execute JobRouter
    console.log('STEP 1: Processing ANALYZE through JobRouter...');
    const rawResult = await JobRouter.route(mockJob, logger);

    const persistedResult = MockDb.lastJobResult;
    const evidence = MockDb.lastEvidence;

    console.log('\n--- RAW WORKER RESULT (Before Persistence) ---');
    console.log(JSON.stringify(rawResult, null, 2));

    console.log('\n--- PERSISTED jobs.result (Canonical Record) ---');
    console.log(JSON.stringify(persistedResult, null, 2));

    console.log('\n--- EVIDENCE Metadata (Forensic Audit) ---');
    console.log(JSON.stringify(evidence, null, 2));

    // Validations
    console.log('\nSTEP 2: Verifying requirements...');
    
    // Check report components in result
    const hasSummary = !!persistedResult.report.summary;
    const hasDocument = !!persistedResult.report.document;
    const hasIssues = persistedResult.report.issues && persistedResult.report.issues.length > 0;
    
    console.log(`- report.summary preserved: ${hasSummary ? 'YES' : 'NO'}`);
    console.log(`- report.document preserved: ${hasDocument ? 'YES' : 'NO'}`);
    console.log(`- report.issues preserved: ${hasIssues ? 'YES' : 'NO'}`);

    // Check issue mapping in evidence
    const mappedViolations = evidence.violations.length;
    console.log(`- issues mapped to evidence.violations: ${mappedViolations === 2 ? 'YES' : 'NO'} (${mappedViolations} found)`);

    // Check evidence vs result
    const isolationPreserved = JSON.stringify(persistedResult) !== JSON.stringify(evidence);
    console.log(`- evidence remains secondary metadata: ${isolationPreserved ? 'YES' : 'NO'}`);

    if (!hasSummary || !hasDocument || !hasIssues || mappedViolations !== 2 || !isolationPreserved) {
        throw new Error('FAILED: One or more validation criteria not met.');
    }

    console.log('\n--- FINAL VALIDATION ---');
    console.log('Final Validation Status: PASSED');
    console.log('Verdict: COMPATIBLE with APP/BFF. Analysis payload fully preserved.');
}

validate().catch(err => {
    console.error('\n--- VALIDATION FAILED ---');
    console.error(err);
    process.exit(1);
});
