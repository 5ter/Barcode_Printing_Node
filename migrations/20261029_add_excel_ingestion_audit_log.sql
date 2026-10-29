-- Persistent audit trail for successfully committed Excel imports.
-- Run this in the bcps_label schema before deploying the application change.

USE bcps_label;

CREATE TABLE IF NOT EXISTS excel_ingestion_audit_log (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    source_file_name varchar(255) NOT NULL,
    file_size_bytes int unsigned NOT NULL DEFAULT 0,
    schema_type enum('STANDARD', 'ARN') NOT NULL,
    rows_processed int unsigned NOT NULL,
    inserted_rows int unsigned NOT NULL DEFAULT 0,
    updated_rows int unsigned NOT NULL DEFAULT 0,
    skipped_rows int unsigned NOT NULL DEFAULT 0,
    status varchar(20) NOT NULL DEFAULT 'SUCCESS',
    uploaded_by enum('ADMIN', 'SUPERVISOR') NOT NULL,
    uploaded_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_excel_ingestion_audit_log_uploaded_at (uploaded_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
