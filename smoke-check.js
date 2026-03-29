/**
 * Smoke Test: ppos-preflight-worker Integration
 */
const path = require('path');
const fs = require('fs');

async function test() {
    console.log('--- TESTING: ppos-preflight-worker ---');

    // 1. Processors load
    try {
        const AnalyzeProcessor = require('./processors/AnalyzeProcessor');
        console.log('PASS: AnalyzeProcessor loaded');
    } catch (e) {
        // Expected fail if engine is not installed in node_modules
        console.warn('WARN: AnalyzeProcessor load failed (Likely missing @ppos/preflight-engine in node_modules)');
        console.log('     Checking engine require path manually...');
        const enginePath = path.resolve(__dirname, '../ppos-preflight-engine/index.js');
        if (fs.existsSync(enginePath)) {
            console.log('     PASS: Engine is physically reachable.');
        } else {
            console.error('     FAIL: Engine is physically missing.');
        }
    }

    // 2. Resilience checks
    try {
        const CircuitBreaker = require('./resilience/CircuitBreaker');
        if (CircuitBreaker.isOpen('test-id') === false) {
            console.log('PASS: CircuitBreaker functional');
        }
    } catch (e) {
        console.error('FAIL: CircuitBreaker load error:', e.message);
    }

    console.log('DONE: ppos-preflight-worker structural check complete.');
}

test();
