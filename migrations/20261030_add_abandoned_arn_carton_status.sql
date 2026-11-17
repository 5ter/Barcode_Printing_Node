-- Preserve empty abandoned ARN cartons in history without treating them as
-- active work or as successfully printed/sealed cartons.
USE bcps_label;

ALTER TABLE arn_cartons
    MODIFY COLUMN status ENUM('OPEN', 'PRINTING', 'PRINT_FAILED', 'SEALED', 'ABANDONED')
    NOT NULL DEFAULT 'OPEN';
