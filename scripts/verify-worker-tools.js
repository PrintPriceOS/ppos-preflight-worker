/**
 * Verification Script: verify-worker-tools.js
 * Enforces presence and operational validity of critical industrial PDF tools.
 * Exits non-zero if pdfinfo, pdfimages, mutool, gs, or qpdf are missing.
 */
const ToolPreflight = require('../utils/ToolPreflight');

async function verify() {
    console.log('--- RUNNING INDUSTRIAL WORKER TOOLS VERIFICATION ---\n');
    
    const status = await ToolPreflight.checkAll();
    
    console.log('Tool Preflight Check Details:');
    for (const [tool, details] of Object.entries(status.tools)) {
        if (details.available) {
            console.log(` [OK] ${tool}: path=${details.path} | version=${details.version}`);
        } else {
            console.log(` [MISSING] ${tool}: error=${details.error}`);
        }
    }
    
    console.log('');

    if (!status.ready) {
        console.error(`[WORKER][TOOLS][FATAL] Verification failed. Missing required critical binaries: ${status.missingTools.join(', ')}`);
        process.exit(1);
    } else {
        console.log('[WORKER][TOOLS][OK] All critical industrial PDF processing tools are ready and verified.');
        process.exit(0);
    }
}

verify().catch(err => {
    console.error('[WORKER][TOOLS][FATAL] Unexpected error during verification:', err);
    process.exit(1);
});
