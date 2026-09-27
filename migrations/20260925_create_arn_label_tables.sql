-- Apply this migration to bcps_label before printing ARN labels.
-- It creates one ARN-only sequence table. It does not alter existing tables.

-- One row per MO. The value is the last issued ARN item number for that MO.
-- A newly inserted MO starts at 0; later labels for the same MO increment it.
CREATE TABLE IF NOT EXISTS arn_label_sequence (
    MO varchar(100) NOT NULL,
    last_item_no bigint unsigned NOT NULL DEFAULT 0,
    created_date datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_timestamp datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (MO)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
