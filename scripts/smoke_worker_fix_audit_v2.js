const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const os = require('os');

// Mock require dependencies
const originalRequire = require('module').prototype.require;
require('module').prototype.require = function(request) {
    if (request === 'uuid') {
        return { v4: () => 'mock-uuid' };
    }
    if (request === '../utils/ControlPlaneArtifacts') {
        return class {
            constructor() {}
            async register(opts) { return true; }
        };
    }
    if (request === '../utils/StorageManager') {
        return class {
            constructor() {}
            getJobSubfolder(tenantId, jobId, sub) {
                return path.join(os.tmpdir(), 'ppos-test', tenantId, jobId, sub);
            }
        };
    }
    if (request === '@ppos/preflight-engine') {
        return {
            createStandardEngine: () => global.engineMock
        };
    }
    if (request === 'fs-extra') {
        return {
            ...fsPromises,
            pathExists: async (p) => {
                try { await fsPromises.access(p); return true; } catch (e) { return false; }
            },
            ensureDir: async (d) => {
                await fsPromises.mkdir(d, { recursive: true });
            },
            writeJson: async (p, obj, opts) => {
                await fsPromises.writeFile(p, JSON.stringify(obj, null, opts.spaces || 2));
            },
            readJson: async (p) => {
                const data = await fsPromises.readFile(p, 'utf8');
                return JSON.parse(data);
            },
            copy: async (src, dest) => {
                await fsPromises.copyFile(src, dest);
            }
        };
    }
    return originalRequire.call(this, request);
};

const AutofixProcessor = require('../processors/AutofixProcessor');

async function runTest(name, engineMockResult, expectedArtifacts, expectReviewRequired) {
    console.log(`\n--- Running Test: ${name} ---`);
    
    global.engineMock = {
        autofixPdf: async () => engineMockResult
    };

    const jobId = `test-job-${Date.now()}`;
    const tenantId = 'test-tenant';
    const tempDir = path.join(os.tmpdir(), 'ppos-test', tenantId, jobId, 'temp');
    const outputDir = path.join(os.tmpdir(), 'ppos-test', tenantId, jobId, 'output');
    
    await fsPromises.mkdir(tempDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    
    const inputPdf = path.join(tempDir, 'input.pdf');
    await fsPromises.writeFile(inputPdf, 'dummy pdf content');

    // Create fixed path for engine
    const fixedPdfPath = path.join(outputDir, 'engine_fixed.pdf');
    if (engineMockResult.fixedPath) {
        await fsPromises.writeFile(engineMockResult.fixedPath, 'dummy fixed pdf');
    }

    const job = {
        data: {
            jobId,
            tenantId,
            input: {
                fileUrl: inputPdf,
                fixes: ['REBUILD_TRIMBOX']
            }
        },
        updateProgress: async () => {}
    };

    const logger = {
        info: (...args) => {},
        warn: (...args) => {},
        error: (...args) => console.error(...args)
    };

    try {
        const result = await AutofixProcessor.process(job, logger);
        
        // Assertions
        const fixAuditPath = path.join(outputDir, 'fix_audit.json');
        const fixAuditStr = await fsPromises.readFile(fixAuditPath, 'utf8');
        const fixAudit = JSON.parse(fixAuditStr);
        
        console.log('Fix Audit version:', fixAudit.version);
        if (fixAudit.version !== '2.0') throw new Error('Expected fix_audit version 2.0');
        
        if (fixAudit.review_required !== expectReviewRequired) {
            throw new Error(`Expected review_required=${expectReviewRequired}, got ${fixAudit.review_required}`);
        }

        const deltaReportPath = path.join(outputDir, 'delta_report.json');
        try {
            await fsPromises.access(deltaReportPath);
        } catch (e) {
            throw new Error('delta_report.json is missing');
        }

        for (const art of expectedArtifacts) {
            if (!result.artifacts[art]) {
                throw new Error(`Expected artifact ${art} to be registered`);
            }
            try {
                await fsPromises.access(path.join(outputDir, result.artifacts[art]));
            } catch (e) {
                throw new Error(`Artifact file missing: ${result.artifacts[art]}`);
            }
        }

        const unexpected = ['certified_pdf', 'review_pdf', 'fixed_pdf', 'fix_audit', 'delta_report'].filter(
            a => !expectedArtifacts.includes(a) && result.artifacts[a]
        );
        if (unexpected.length > 0) {
            throw new Error(`Unexpected artifacts registered: ${unexpected.join(', ')}`);
        }

        console.log(`Test ${name} PASS`);
    } catch (e) {
        console.error(`Test ${name} FAIL: ${e.message}`);
        throw e;
    }
}

async function main() {
    // A. Low-risk successful fix
    await runTest('A. Low-risk successful fix', {
        fixedPath: path.join(os.tmpdir(), 'engine_fixed_a.pdf'),
        applied_fixes: [{ fix_id: 'REBUILD_TRIMBOX', risk_level: 'LOW', requires_human_review: false }],
        skipped_fixes: [],
        failed_fixes: [],
        fix_results: [{ fix_id: 'REBUILD_TRIMBOX', status: 'APPLIED', risk_level: 'LOW', requires_human_review: false }],
        review_required: false,
        production_certified: true
    }, ['fixed_pdf', 'certified_pdf', 'fix_audit', 'delta_report'], false);

    // B. Review-required fix
    await runTest('B. Review-required fix', {
        fixedPath: path.join(os.tmpdir(), 'engine_fixed_b.pdf'),
        applied_fixes: [{ fix_id: 'CONVERT_CMYK', risk_level: 'HIGH', requires_human_review: true }],
        skipped_fixes: [],
        failed_fixes: [],
        fix_results: [{ fix_id: 'CONVERT_CMYK', status: 'APPLIED', risk_level: 'HIGH', requires_human_review: true }],
        review_required: true,
        production_certified: false
    }, ['fixed_pdf', 'review_pdf', 'fix_audit', 'delta_report'], true);

    // C. Unsupported fix
    await runTest('C. Unsupported fix', {
        fixedPath: path.join(os.tmpdir(), 'engine_fixed_c.pdf'),
        applied_fixes: [],
        skipped_fixes: [{ fix_id: 'EMBED_FONTS', status: 'SKIPPED' }],
        failed_fixes: [],
        fix_results: [{ fix_id: 'EMBED_FONTS', status: 'SKIPPED' }],
        review_required: false,
        production_certified: true
    }, ['fixed_pdf', 'certified_pdf', 'fix_audit', 'delta_report'], false);

    // D. Failed critical fix
    await runTest('D. Failed critical fix', {
        fixedPath: path.join(os.tmpdir(), 'engine_fixed_d.pdf'),
        applied_fixes: [],
        skipped_fixes: [],
        failed_fixes: [{ fix_id: 'REBUILD_TRIMBOX', risk_level: 'CRITICAL', status: 'FAILED' }],
        fix_results: [{ fix_id: 'REBUILD_TRIMBOX', status: 'FAILED', risk_level: 'CRITICAL' }],
        review_required: false,
        production_certified: false
    }, ['fixed_pdf', 'fix_audit', 'delta_report'], false); // Should certified_pdf be suppressed? Yes.

    console.log('\nAll tests passed.');
}

main().catch(() => process.exit(1));
