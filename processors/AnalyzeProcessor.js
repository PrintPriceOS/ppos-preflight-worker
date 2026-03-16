/**
 * AnalyzeProcessor
 * 
 * Invokes the Engine for PDF analysis.
 */
const { createStandardEngine } = require('@ppos/preflight-engine');

class AnalyzeProcessor {
    static async process(data) {
        const { filePath, options } = data;
        
        console.log(`[PROCESSOR][ANALYZE] Running engine on: ${filePath}`);
        
        const engine = createStandardEngine();
        const report = await engine.analyzePdf(filePath, options);
        
        return {
            status: 'COMPLETED',
            report,
            processedAt: new Date().toISOString()
        };
    }
}

module.exports = AnalyzeProcessor;
