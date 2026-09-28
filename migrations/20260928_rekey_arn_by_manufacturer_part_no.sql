-- Move ARN Excel rows and running-number scope from MO to Manufacturer Part No.
-- MO remains required on the print form and is recorded in print history only.
-- Back up the database and run the duplicate preflight below before proceeding.

USE bcps_label;

-- Both checks must be clear before continuing. If either returns rows, resolve
-- those imported records first; do not continue to the ALTER TABLE statements.
SELECT manufacturer_part_no, COUNT(*) AS row_count
FROM arn_label_data
GROUP BY manufacturer_part_no
HAVING COUNT(*) > 1;

SELECT mo, manufacturer_part_no
FROM arn_label_data
WHERE manufacturer_part_no IS NULL OR TRIM(manufacturer_part_no) = '';

-- Keep legacy MO values on existing imported rows, but make MO optional and
-- replace its primary-key role with Manufacturer Part No.
SET @arn_data_has_mo_primary_key = (
    SELECT COUNT(*)
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'arn_label_data'
      AND CONSTRAINT_NAME = 'PRIMARY'
      AND COLUMN_NAME = 'mo'
);
SET @arn_data_rekey_sql = IF(
    @arn_data_has_mo_primary_key > 0,
    'ALTER TABLE arn_label_data DROP PRIMARY KEY, MODIFY COLUMN mo varchar(100) NULL, DROP INDEX idx_arn_label_data_mfr_part, ADD PRIMARY KEY (manufacturer_part_no)',
    'SELECT ''arn_label_data is already keyed by manufacturer_part_no'' AS migration_status'
);
PREPARE arn_data_rekey_stmt FROM @arn_data_rekey_sql;
EXECUTE arn_data_rekey_stmt;
DEALLOCATE PREPARE arn_data_rekey_stmt;

-- New per-part sequence. Seed from prior print history so existing part
-- numbers continue after their highest previously issued item number.
CREATE TABLE IF NOT EXISTS arn_label_part_sequence (
    manufacturer_part_no varchar(255) NOT NULL,
    last_item_no bigint unsigned NOT NULL DEFAULT 1,
    created_date datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_timestamp datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (manufacturer_part_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO arn_label_part_sequence (manufacturer_part_no, last_item_no)
SELECT manufacturer_part_no, MAX(item_no)
FROM arn_label_print_history
GROUP BY manufacturer_part_no
ON DUPLICATE KEY UPDATE last_item_no = GREATEST(last_item_no, VALUES(last_item_no));

-- MO is now a reference only, so it cannot uniquely constrain item numbers.
-- Keep all existing print records and allow the same MO/item number across
-- different Manufacturer Part Nos.; the new per-part sequence prevents future
-- duplicates for a given part number.
SET @arn_old_history_key_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'arn_label_print_history'
      AND INDEX_NAME = 'uq_arn_print_history_mo_item'
);
SET @arn_history_index_sql = IF(
    @arn_old_history_key_exists > 0,
    'ALTER TABLE arn_label_print_history DROP INDEX uq_arn_print_history_mo_item, ADD INDEX idx_arn_print_history_part_item (manufacturer_part_no, item_no)',
    'SELECT ''ARN print history index already migrated'' AS migration_status'
);
PREPARE arn_history_index_stmt FROM @arn_history_index_sql;
EXECUTE arn_history_index_stmt;
DEALLOCATE PREPARE arn_history_index_stmt;
