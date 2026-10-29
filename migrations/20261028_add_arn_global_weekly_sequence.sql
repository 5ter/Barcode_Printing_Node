-- ARN Mfr Ref running numbers are global within a YYWW work week.
-- They do not restart when the MO or Manufacturer Part No. changes.
-- Run after the existing ARN migrations, including 20261021_add_arn_weekly_sequence.sql.

USE bcps_label;

CREATE TABLE IF NOT EXISTS arn_label_weekly_sequence (
    date_code varchar(10) NOT NULL,
    last_item_no bigint unsigned NOT NULL DEFAULT 0,
    created_date datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_timestamp datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (date_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Preserve the highest already-issued number in each historical week. This
-- prevents a migration from reusing an existing Mfr Ref label reference.
INSERT INTO arn_label_weekly_sequence (date_code, last_item_no)
SELECT date_code, MAX(item_no)
FROM arn_label_print_history
WHERE date_code IS NOT NULL
  AND TRIM(date_code) <> ''
GROUP BY date_code
ON DUPLICATE KEY UPDATE last_item_no = GREATEST(last_item_no, VALUES(last_item_no));
