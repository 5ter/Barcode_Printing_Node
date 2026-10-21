-- Make ARN item numbers reset for each Manufacturer Part No. and YYWW week,
-- matching the Standard label's weekly reset behavior.
-- Existing ARN history is retained and used to seed the new sequence table.
-- The older arn_label_part_sequence table is intentionally left untouched.

USE bcps_label;

CREATE TABLE IF NOT EXISTS arn_label_weekly_sequence (
    manufacturer_part_no varchar(255) NOT NULL,
    date_code varchar(10) NOT NULL,
    last_item_no bigint unsigned NOT NULL DEFAULT 1,
    created_date datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_timestamp datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (manufacturer_part_no, date_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Idempotently preserve the highest item number already issued for each part
-- in each week. A week with no history begins at item number 1 on first print.
INSERT INTO arn_label_weekly_sequence (manufacturer_part_no, date_code, last_item_no)
SELECT manufacturer_part_no, date_code, MAX(item_no)
FROM arn_label_print_history
WHERE manufacturer_part_no IS NOT NULL
  AND date_code IS NOT NULL
GROUP BY manufacturer_part_no, date_code
ON DUPLICATE KEY UPDATE last_item_no = GREATEST(last_item_no, VALUES(last_item_no));
