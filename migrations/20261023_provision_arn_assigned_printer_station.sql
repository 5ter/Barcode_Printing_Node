-- Backfill the ARN station for the printer currently assigned to ARN.
-- Future ARN assignments are provisioned transactionally by printerSetup.js.

USE bcps_label;

INSERT INTO arn_station_lock (printer_id)
SELECT printer_id
FROM workflow_printer_assignments
WHERE workflow_key = 'ARN'
  AND printer_id IS NOT NULL
ON DUPLICATE KEY UPDATE printer_id = VALUES(printer_id);
