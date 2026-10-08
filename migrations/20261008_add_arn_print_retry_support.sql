-- Add operator-initiated same-reference ARN reprint support.
-- Run once after arn_label_print_history exists and has its final ARN schema.
-- Existing history rows remain; they have no saved payload and cannot be
-- retried exactly. New jobs store the exact SBPL payload before printer send.

USE bcps_label;

ALTER TABLE arn_label_print_history
    ADD COLUMN label_payload MEDIUMTEXT NULL AFTER label_content,
    ADD COLUMN print_status ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'SENT' AFTER label_payload,
    ADD COLUMN retry_count int unsigned NOT NULL DEFAULT 0 AFTER print_status,
    ADD COLUMN last_retry_at datetime NULL AFTER retry_count,
    ADD COLUMN last_error text NULL AFTER last_retry_at;
