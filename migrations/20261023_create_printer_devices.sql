-- Registry for printers added through Admin Printer Setup and overrides for
-- the server-defined PRINTER_A-D entries. New devices start unassigned.

USE bcps_label;

CREATE TABLE IF NOT EXISTS printer_devices (
    printer_id varchar(45) NOT NULL,
    printer_name varchar(120) NOT NULL,
    location varchar(160) NULL,
    printer_model varchar(120) NULL,
    ip_address varchar(45) NOT NULL,
    mac_address varchar(17) NULL,
    tcp_port smallint unsigned NOT NULL DEFAULT 9100,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (printer_id),
    UNIQUE KEY uq_printer_devices_endpoint (ip_address, tcp_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
