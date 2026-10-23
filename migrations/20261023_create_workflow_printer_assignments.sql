-- Map the Standard and ARN workflows to configured printers.
-- Printer IP/port/name values remain in config/printerSetting.js.
-- A printer can serve only one workflow; NULL means that workflow is unassigned.

USE bcps_label;

CREATE TABLE IF NOT EXISTS workflow_printer_assignments (
    workflow_key varchar(20) NOT NULL,
    printer_id varchar(45) NULL,
    updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (workflow_key),
    UNIQUE KEY uq_workflow_printer_assignments_printer (printer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Also support a database where this table was created by an earlier draft
-- with printer_id marked NOT NULL. The unique index still prevents sharing.
ALTER TABLE workflow_printer_assignments
    MODIFY COLUMN printer_id varchar(45) NULL;

-- Preserve the current Standard default and use the printer already identified
-- in printerSetting.js as the ARN Label Printer. Existing assignments are kept.
INSERT IGNORE INTO workflow_printer_assignments (workflow_key, printer_id)
VALUES ('STANDARD', 'PRINTER_A'), ('ARN', 'PRINTER_D');
