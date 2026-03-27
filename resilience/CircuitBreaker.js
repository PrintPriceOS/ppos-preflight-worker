/**
 * CircuitBreaker
 * 
 * V1.9.0 - Prevents toxic loops and quarantine handling.
 */
class CircuitBreaker {
    constructor() {
        this.failureCount = new Map();
        this.threshold = 3;
        this.quarantineTimeMs = 3600000; // 1 hour
    }

    isOpen(entityId) {
        const stats = this.failureCount.get(entityId);
        if (!stats) return false;
        
        if (stats.count >= this.threshold) {
            const now = Date.now();
            if (now < stats.lastFailure + this.quarantineTimeMs) {
                return true;
            }
            // Reset if recovery time passed
            this.failureCount.delete(entityId);
        }
        return false;
    }

    recordFailure(entityId, error) {
        const stats = this.failureCount.get(entityId) || { count: 0, lastFailure: 0 };
        stats.count++;
        stats.lastFailure = Date.now();
        this.failureCount.set(entityId, stats);
        
        console.warn(`[CIRCUIT-BREAKER] Failure recorded for ${entityId}. Total: ${stats.count}/${this.threshold}`);
    }
}

module.exports = new CircuitBreaker();
