-- Make ARN item numbers reset for each Manufacturer Part No. and YYWW week,
-- matching the Standard label's weekly reset behavior, by upgrading the
-- existing arn_label_part_sequence table (no replacement table is needed).
-- ARN print history is retained and used to seed the weekly counters.

USE bcps_label;

-- Remove the separate weekly table from the earlier draft, if that draft was
-- already applied during testing. Its values are recoverable from print history.
DROP TABLE IF EXISTS arn_label_weekly_sequence;

-- Add the week to the existing per-part primary key. The temporary 0000 value
-- is only for old aggregate rows, which are discarded after history is seeded.
SET @arn_has_date_code = (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'arn_label_part_sequence'
      AND COLUMN_NAME = 'date_code'
);
SET @arn_has_weekly_primary_key = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'arn_label_part_sequence'
      AND INDEX_NAME = 'PRIMARY'
      AND COLUMN_NAME = 'date_code'
);
SET @arn_sequence_alter_sql = IF(
    @arn_has_date_code = 0,
    'ALTER TABLE arn_label_part_sequence DROP PRIMARY KEY, ADD COLUMN date_code varchar(10) NOT NULL DEFAULT ''0000'' AFTER manufacturer_part_no, ADD PRIMARY KEY (manufacturer_part_no, date_code)',
    IF(
        @arn_has_weekly_primary_key = 0,
        'ALTER TABLE arn_label_part_sequence DROP PRIMARY KEY, ADD PRIMARY KEY (manufacturer_part_no, date_code)',
        'SELECT ''ARN sequence table already has its weekly primary key'' AS migration_status'
    )
);
PREPARE arn_sequence_alter_stmt FROM @arn_sequence_alter_sql;
EXECUTE arn_sequence_alter_stmt;
DEALLOCATE PREPARE arn_sequence_alter_stmt;

-- Seed each part/week from its highest previously issued item number. A week
-- with no history starts at item number 1 on the next print.
INSERT INTO arn_label_part_sequence (manufacturer_part_no, date_code, last_item_no)
SELECT manufacturer_part_no, date_code, MAX(item_no)
FROM arn_label_print_history
WHERE manufacturer_part_no IS NOT NULL
  AND date_code IS NOT NULL
GROUP BY manufacturer_part_no, date_code
ON DUPLICATE KEY UPDATE last_item_no = GREATEST(last_item_no, VALUES(last_item_no));

-- Old rows had no week key, so remove those obsolete aggregate counters.
DELETE FROM arn_label_part_sequence WHERE date_code = '0000';
