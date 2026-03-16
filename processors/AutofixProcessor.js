/**
 * AutofixProcessor
 * 
 * Invokes the Engine for PDF fixes.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');

class AutofixProcessor {
    static async process(data) {
        const { filePath, policy, options } = data;
        
        console.log(`[PROCESSOR][AUTOFIX] Applying policy ${policy} to: ${filePath}`);
        
        const engine = createStandardEngine();
        const result = await engine.autofixPdf(filePath, policy, options);
        
        return {
            status: 'FIXED',
            result,
            fixedAt: new Date().toISOString()
        };
    }
}

module.exports = AutofixProcessor;
