/**
 * Configuration file for application settings and external dependencies.
 */
const settings = {
    // Standard application port
    PORT: process.env.PORT || 3003,

    // Define multiple printer configurations here
    // Use the printer ID as the key for easy lookup (e.g., 'A', 'B')
    PRINTERS: {
        'PRINTER_A': {
            // Main production printer
            IP: process.env.PRINTER_A_IP || '10.0.37.225',
            PORT: process.env.PRINTER_A_PORT || 9100,
            NAME: 'Main Production Line A'
        },
        'PRINTER_B': {
            // Secondary production printer
            IP: process.env.PRINTER_B_IP || '10.0.16.2',
            PORT: process.env.PRINTER_B_PORT || 9100,
            NAME: 'Secondary Line B'
        },
        
        'PRINTER_C': {
            // Secondary production printer
            IP: process.env.PRINTER_C_IP || '192.168.112.53',
            PORT: process.env.PRINTER_C_PORT || 9100,
            NAME: 'Secondary Line C'
        },
        // ARN Label Printer
        'PRINTER_D': {
            // ARN Label Printer
            IP: process.env.PRINTER_D_IP || '192.168.5.43',
            PORT: process.env.PRINTER_D_PORT || 9100,
            NAME: 'ARN Label Printer'
        },
    },

    /**
     * Helper function to retrieve printer configuration by a simple ID.
     * @param {string} printerId Key from the PRINTERS object (e.g., 'PRINTER_A').
     * @returns {Object|null} The printer configuration object or null if not found.
     */
    getPrinterConfig: (printerId) => {
        return settings.PRINTERS[printerId] || null;
    }
};

module.exports = settings;
