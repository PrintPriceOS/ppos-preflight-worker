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
     */
    shouldRetry(error) {
        const fatalErrors = [
            'INPUT_FILE_NOT_FOUND',
            'INVALID_PDF_STRUCTURE',
            'QUARANTINE_TRIGGERED'
        ];
        
        return !fatalErrors.includes(error.code);
    }
};
