-- ARN Excel data is kept separate from the Standard product and print tables.
-- MO is the immutable unique key for an imported ARN label row.

CREATE TABLE IF NOT EXISTS arn_label_data (
    mo varchar(100) NOT NULL,
    arn_part_no varchar(255) NOT NULL,
    quantity int unsigned NOT NULL,
    manufacturer_part_no varchar(255) NOT NULL,
    purchase_order varchar(100) NOT NULL,
    imported_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mo),
    KEY idx_arn_label_data_mfr_part (manufacturer_part_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One history row for each successful ARN label print.
CREATE TABLE IF NOT EXISTS arn_label_print_history (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    mo varchar(100) NOT NULL,
    arn_part_no varchar(255) NOT NULL,
    quantity int unsigned NOT NULL,
    manufacturer_part_no varchar(255) NOT NULL,
    purchase_order varchar(100) NOT NULL,
    date_code varchar(10) NOT NULL,
    item_no bigint unsigned NOT NULL,
    label_content varchar(100) NOT NULL,
    printer_id varchar(45) NOT NULL,
    printed_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_arn_print_history_mo_item (mo, item_no),
    KEY idx_arn_print_history_mfr_part (manufacturer_part_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
