/**
 * RetryPolicy
 * 
 * Defines the backoff and retry strategy for async jobs.
 */
module.exports = {
    maxRetries: 10,
    backoff: {
        type: 'exponential',
        delay: 30000 // 30s initial delay
    },
    
    /**
     * Classifies errors to decide if a retry should be skipped.
     * Aligned with Phase 10 non-retryable contract rules.
     */
    shouldRetry(error) {
        if (!error) return true;
        
        const message = error.message || '';
        const code = error.code || '';
        
        const fatalPatterns = [
            'INPUT_FILE_NOT_FOUND',
            'ANALYZE-CONTRACT-ERROR',
            'AUTOFIX-CONTRACT-ERROR',
            'isolation breach',
            'INVALID_PDF_STRUCTURE',
            'QUARANTINE_TRIGGERED'
        ];
        
        for (const pattern of fatalPatterns) {
            if (message.includes(pattern) || code.includes(pattern)) {
                return false;
            }
        }
        
        return true;
    }
};
