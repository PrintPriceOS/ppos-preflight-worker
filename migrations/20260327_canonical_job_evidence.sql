-- Phase 10 Production Patch: Forensic Evidence Schema Alignment
-- This migration ensures the presence of the job_evidence table required by the worker audit layer.

CREATE TABLE IF NOT EXISTS `job_evidence` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `job_id` VARCHAR(128) NOT NULL,
    `tenant_id` VARCHAR(128) NOT NULL,
    `request_id` VARCHAR(128),
    `event_type` VARCHAR(64) NOT NULL,
    `metadata` JSON NOT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Forensic Lookup Indices
    INDEX `idx_job_id` (`job_id`),
    INDEX `idx_tenant_id` (`tenant_id`),
    INDEX `idx_event_type` (`event_type`),
    INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
