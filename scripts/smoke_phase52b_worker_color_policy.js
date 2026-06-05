const fs = require('fs').promises;
const path = require('path');

const StorageManager = require('../utils/StorageManager');
const os = require('os');

async function run() {
    const storage = new StorageManager();
    const tenantId = 'tenant-52b';
    const tempDir = path.join(os.tmpdir(), `phase52b-${Date.now()}`);
    
    // We mock the Preflight Engine to return specific fixes for each test
    const { createStandardEngine } = require('@ppos/preflight-engine');
    const actualCreateStandardEngine = createStandardEngine;
    
    // We will override createStandardEngine to inject our test cases
    let currentMockResult = {};
    const mockEngine = {
        autofixPdf: async (input, payload) => {
            return {
                ok: true,
                fixedPath: input, // just return input
                applied_fixes: currentMockResult.applied_fixes || [],
                skipped_fixes: currentMockResult.skipped_fixes || [],
                failed_fixes: currentMockResult.failed_fixes || [],
                fix_results: currentMockResult.fix_results || [],
                review_required: currentMockResult.review_required || false,
                review_required_reasons: currentMockResult.review_required_reasons || [],
                production_certified: currentMockResult.production_certified !== undefined ? currentMockResult.production_certified : true
            };
        }
    };
    
    const requireCache = require.cache[require.resolve('@ppos/preflight-engine')];
    if (requireCache) {
        requireCache.exports.createStandardEngine = () => mockEngine;
    }
    
    const AutofixProcessor = require('../processors/AutofixProcessor');

    const testPdfPath = path.join(tempDir, 'test.pdf');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(testPdfPath, '%PDF-1.4\n%EOF');

    const runScenario = async (name, appliedFixesMock, sourceFindings, requestedFixes) => {
        const jobId = `job-52b-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        currentMockResult = {
            applied_fixes: appliedFixesMock,
            production_certified: true
        };

        const job = {
            data: {
                jobId,
                tenantId,
                input: { fileUrl: testPdfPath },
                policyProfile: 'default',
                findings: sourceFindings,
                fixes: requestedFixes
            },
            updateProgress: async () => {}
        };

        const result = await AutofixProcessor.process(job, {
            info: () => {}, warn: () => {}, error: () => {}
        });

        const outputDir = storage.getJobSubfolder(tenantId, jobId, 'output');
        const auditPath = path.join(outputDir, 'fix_audit.json');
        const deltaPath = path.join(outputDir, 'delta_report.json');
        
        let audit = null;
        let delta = null;
        try {
            const auditData = await fs.readFile(auditPath, 'utf8');
            audit = JSON.parse(auditData);
        } catch (e) {}
        try {
            const deltaData = await fs.readFile(deltaPath, 'utf8');
            delta = JSON.parse(deltaData);
        } catch (e) {}

        return { result, audit, delta };
    };

    const scenarios = [];

    console.log("Running Phase 52B Smoke Tests...");

    // Test A: CONVERT_CMYK applied blocks certification
    let out = await runScenario('CONVERT_CMYK', [{ fix_id: 'CONVERT_CMYK', status: 'APPLIED' }], [], ['CONVERT_CMYK']);
    const aPassed = out.audit && out.audit.review_required === true && out.audit.production_certified === false;
    scenarios.push({ scenario: 'A', name: 'CONVERT_CMYK blocks certification', pass: !!aPassed, audit: out.audit, delta: out.delta });

    // Test B: INJECT_OUTPUT_INTENT alone can remain safe
    out = await runScenario('INJECT_OUTPUT_INTENT', [{ fix_id: 'INJECT_OUTPUT_INTENT', status: 'APPLIED' }], [], ['INJECT_OUTPUT_INTENT']);
    const bPassed = out.audit && out.audit.review_required === false && out.audit.production_certified === true;
    scenarios.push({ scenario: 'B', name: 'INJECT_OUTPUT_INTENT alone', pass: !!bPassed, audit: out.audit, delta: out.delta });

    // Test C: INJECT_OUTPUT_INTENT + ICC risk blocks certification
    out = await runScenario('INJECT_OUTPUT_INTENT + ICC', [{ fix_id: 'INJECT_OUTPUT_INTENT', status: 'APPLIED' }], [{ id: 'ICC_MISMATCH' }], ['INJECT_OUTPUT_INTENT']);
    const cPassed = out.audit && out.audit.review_required === true && out.audit.production_certified === false;
    scenarios.push({ scenario: 'C', name: 'INJECT_OUTPUT_INTENT + ICC', pass: !!cPassed, audit: out.audit, delta: out.delta });

    // Test D: REDUCE_TAC requested, must be skipped
    out = await runScenario('REDUCE_TAC', [{ fix_id: 'REDUCE_TAC', status: 'APPLIED' }], [], ['REDUCE_TAC']);
    const dPassed = out.audit && out.audit.applied_fixes.length === 0 && out.audit.skipped_fixes.some(f => f.fix_id === 'REDUCE_TAC');
    scenarios.push({ scenario: 'D', name: 'Unsupported REDUCE_TAC is skipped', pass: !!dPassed, audit: out.audit, delta: out.delta });

    // Test E: RICH_BLACK_TEXT finding forces review
    out = await runScenario('RICH_BLACK_TEXT', [], [{ id: 'RICH_BLACK_TEXT' }], []);
    const ePassed = out.audit && out.audit.review_required === true && out.audit.production_certified === false;
    scenarios.push({ scenario: 'E', name: 'RICH_BLACK_TEXT finding', pass: !!ePassed, audit: out.audit, delta: out.delta });

    // Test F: REGISTRATION_COLOR_MISUSE finding forces review
    out = await runScenario('REGISTRATION_COLOR_MISUSE', [], [{ id: 'REGISTRATION_COLOR_MISUSE' }], []);
    const fPassed = out.audit && out.audit.review_required === true && out.audit.production_certified === false;
    scenarios.push({ scenario: 'F', name: 'REGISTRATION_COLOR_MISUSE finding', pass: !!fPassed, audit: out.audit, delta: out.delta });

    // Test G: MIXED_RGB_CMYK finding forces review
    out = await runScenario('MIXED_RGB_CMYK', [], [{ id: 'MIXED_RGB_CMYK' }], []);
    const gPassed = out.audit && out.audit.review_required === true && out.audit.production_certified === false;
    scenarios.push({ scenario: 'G', name: 'MIXED_RGB_CMYK finding', pass: !!gPassed, audit: out.audit, delta: out.delta });

    // Test H: Findings are never applied fixes
    out = await runScenario('Findings never applied', [{ fix_id: 'RICH_BLACK_TEXT', status: 'APPLIED' }], [{ id: 'RICH_BLACK_TEXT' }], ['RICH_BLACK_TEXT']);
    const hPassed = out.audit && !out.audit.applied_fixes.some(f => f.fix_id === 'RICH_BLACK_TEXT');
    scenarios.push({ scenario: 'H', name: 'Findings never applied', pass: !!hPassed, audit: out.audit, delta: out.delta });
    
    const allPassed = scenarios.every(s => s.pass);

    const reportPathJson = path.join(__dirname, '../reports/phase52b_worker_color_policy.json');
    const reportPathMd = path.join(__dirname, '../reports/phase52b_worker_color_policy.md');
    
    await fs.mkdir(path.dirname(reportPathJson), { recursive: true });

    await fs.writeFile(reportPathJson, JSON.stringify(scenarios, null, 2));

    let mdContent = '# Phase 52B Smoke Test Report\n\n';
    scenarios.forEach(s => {
        mdContent += `## Scenario ${s.scenario}: ${s.name}\n`;
        mdContent += `**Status:** ${s.pass ? '✅ PASS' : '❌ FAIL'}\n\n`;
        mdContent += `### Audit Result\n\`\`\`json\n${JSON.stringify(s.audit, null, 2)}\n\`\`\`\n\n`;
        mdContent += `### Delta Result\n\`\`\`json\n${JSON.stringify(s.delta, null, 2)}\n\`\`\`\n\n`;
    });

    await fs.writeFile(reportPathMd, mdContent);

    console.log(`Smoke tests completed. All passed: ${allPassed}`);
    
    // cleanup
    if (requireCache) {
        requireCache.exports.createStandardEngine = actualCreateStandardEngine;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    
    if (!allPassed) process.exit(1);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
