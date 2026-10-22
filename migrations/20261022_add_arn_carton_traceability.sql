-- Add persistent ARN carton locks and raw product-scan traceability.
-- Run after 20261021_add_arn_weekly_sequence.sql and the existing ARN migrations.
-- Standard label tables are not changed by this migration.

USE bcps_label;

CREATE TABLE IF NOT EXISTS arn_station_lock (
    printer_id varchar(45) NOT NULL,
    mo varchar(100) NULL,
    manufacturer_part_no varchar(255) NULL,
    arn_part_no varchar(255) NULL,
    box_capacity int unsigned NULL,
    purchase_order varchar(100) NULL,
    current_carton_id bigint unsigned NULL,
    locked_at datetime NULL,
    updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (printer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO arn_station_lock (printer_id)
VALUES ('PRINTER_A'), ('PRINTER_B'), ('PRINTER_C'), ('PRINTER_D');

CREATE TABLE IF NOT EXISTS arn_cartons (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    printer_id varchar(45) NOT NULL,
    mo varchar(100) NOT NULL,
    manufacturer_part_no varchar(255) NOT NULL,
    arn_part_no varchar(255) NOT NULL,
    purchase_order varchar(100) NOT NULL,
    box_capacity int unsigned NOT NULL,
    scanned_count int unsigned NOT NULL DEFAULT 0,
    status enum('OPEN', 'PRINTING', 'PRINT_FAILED', 'SEALED') NOT NULL DEFAULT 'OPEN',
    label_history_id bigint unsigned NULL,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sealed_at datetime NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_arn_carton_label_history (label_history_id),
    KEY idx_arn_carton_printer_status (printer_id, status, id),
    KEY idx_arn_carton_mo_part (mo, manufacturer_part_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS arn_carton_scans (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    carton_id bigint unsigned NOT NULL,
    scanned_content text NOT NULL,
    scanned_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at datetime NULL,
    PRIMARY KEY (id),
    KEY idx_arn_carton_scan_carton (carton_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Link new carton-label print attempts to their cartons. Historical label rows
-- remain valid with carton_id NULL.
SET @arn_history_has_carton_id = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'arn_label_print_history'
      AND COLUMN_NAME = 'carton_id'
);
SET @arn_history_carton_column_sql = IF(
    @arn_history_has_carton_id = 0,
    'ALTER TABLE arn_label_print_history ADD COLUMN carton_id bigint unsigned NULL AFTER id',
    'SELECT ''arn_label_print_history.carton_id already exists'' AS migration_status'
);
PREPARE arn_history_carton_column_stmt FROM @arn_history_carton_column_sql;
EXECUTE arn_history_carton_column_stmt;
DEALLOCATE PREPARE arn_history_carton_column_stmt;

SET @arn_history_carton_index_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'arn_label_print_history'
      AND INDEX_NAME = 'idx_arn_print_history_carton'
);
SET @arn_history_carton_index_sql = IF(
    @arn_history_carton_index_exists = 0,
    'ALTER TABLE arn_label_print_history ADD INDEX idx_arn_print_history_carton (carton_id)',
    'SELECT ''arn_label_print_history carton index already exists'' AS migration_status'
);
PREPARE arn_history_carton_index_stmt FROM @arn_history_carton_index_sql;
EXECUTE arn_history_carton_index_stmt;
DEALLOCATE PREPARE arn_history_carton_index_stmt;
