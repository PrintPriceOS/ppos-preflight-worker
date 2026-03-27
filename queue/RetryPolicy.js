/**
 * RetryPolicy
 * 
 * Defines the Phase 7 failure handling and classification strategy.
 * Deterministic errors (invalid PDF, policy rejection) are NOT retried.
 * Transient errors (network, IO) are retried with exponential backoff.
 */
module.exports = {
    maxRetries: 3,
    backoff: {
        type: 'exponential',
        delay: 3000 // 3s initial delay
    },
    
    /**
     * Classifies errors to decide if a retry should be skipped.
     * Phase 7 Classification Matrix
     */
    classifyError(error) {
        const deterministicErrorCodes = [
            'INVALID_PDF_STRUCTURE',
            'POLICY_VIOLATION_FATAL',
            'FILENAME_TAMPER_DETECTED',
            'ISO_VERSION_NOT_SUPPORTED',
            'QUARANTINE_ACTIVE'
        ];
        
        const transientErrorCodes = [
            'REDIS_CONNECTION_LOST',
            'STORAGE_TIMEOUT',
            'NETWORK_UNREACHABLE'
        ];

        if (deterministicErrorCodes.includes(error.code)) {
            return "DO_NOT_RETRY";
        }

        if (error.code === 'GOVERNANCE_REJECTION') {
            return "REQUEUE_LATER";
        }

        return "RETRY";
    }
};
