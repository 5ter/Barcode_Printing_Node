-- Add placement information to printers already registered in the database.
-- Safe to run after 20261023_create_printer_devices.sql, including when that
-- create migration is updated to include this column for fresh installations.

USE bcps_label;

SET @printer_location_migration_sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE printer_devices ADD COLUMN location varchar(160) NULL AFTER printer_name',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'printer_devices'
      AND column_name = 'location'
);

PREPARE printer_location_migration_stmt FROM @printer_location_migration_sql;
EXECUTE printer_location_migration_stmt;
DEALLOCATE PREPARE printer_location_migration_stmt;
