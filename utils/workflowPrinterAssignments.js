const printerSettings = require('../config/printerSetting');

const WORKFLOWS = Object.freeze({
    STANDARD: Object.freeze({
        key: 'STANDARD',
        label: 'Standard Product Label',
        description: 'The established MO and Actmax Part No. product-label workflow.'
    }),
    ARN: Object.freeze({
        key: 'ARN',
        label: 'ARN Customer Carton Workflow',
        description: 'Carton setup, product scans, and ARN carton label printing.'
    })
});

function normalizePrinterId(value) {
    const rawValue = String(value || '').trim().toUpperCase();
    const printerId = rawValue.startsWith('PRINTER_') ? rawValue : 'PRINTER_' + rawValue;
    return /^PRINTER_[A-Z0-9][A-Z0-9_-]{0,35}$/.test(printerId) ? printerId : null;
}

async function loadWorkflowPrinterAssignments(connection) {
    const [rows] = await connection.execute(
        'SELECT workflow_key, printer_id, updated_at FROM workflow_printer_assignments'
    );
    const assignments = {};

    for (const row of rows) {
        const workflow = String(row.workflow_key || '').trim().toUpperCase();
        const printerId = normalizePrinterId(row.printer_id);
        if (!Object.prototype.hasOwnProperty.call(WORKFLOWS, workflow) || !printerId) continue;
        assignments[workflow] = printerId;
    }

    return assignments;
}

async function getAssignedPrinterId(connection, workflowKey, lockForUpdate = false) {
    const workflow = String(workflowKey || '').trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(WORKFLOWS, workflow)) {
        throw new Error('Unknown label workflow: ' + workflow);
    }
    const [rows] = await connection.execute(
        'SELECT printer_id FROM workflow_printer_assignments WHERE workflow_key = ?' +
            (lockForUpdate ? ' FOR UPDATE' : ''),
        [workflow]
    );
    const printerId = rows.length ? normalizePrinterId(rows[0].printer_id) : null;
    if (rows.length && rows[0].printer_id != null && !printerId) {
        throw new Error('The ' + workflow + ' workflow is assigned to an unknown printer.');
    }
    return printerId;
}

function getConfiguredPrinters() {
    return Object.entries(printerSettings.PRINTERS).map(([id, config]) => ({
        id,
        letter: id.replace(/^PRINTER_/, ''),
        name: config.NAME,
        model: config.MODEL || '',
        ipAddress: config.IP,
        macAddress: config.MAC || '',
        port: Number(config.PORT) || 9100,
        location: '',
        isApplicationPrinter: true,
        source: 'application'
    }));
}

async function loadConfiguredPrinters(connection) {
    const printers = getConfiguredPrinters();
    const printerIndexes = new Map(printers.map((printer, index) => [printer.id, index]));
    const [rows] = await connection.execute(
        'SELECT printer_id, printer_name, location, printer_model, ip_address, mac_address, tcp_port ' +
        'FROM printer_devices ORDER BY created_at, printer_id'
    );
    for (const row of rows) {
        const id = normalizePrinterId(row.printer_id);
        if (!id) continue;
        const printer = {
            id,
            letter: id.replace(/^PRINTER_/, ''),
            name: String(row.printer_name || id),
            model: String(row.printer_model || ''),
            ipAddress: String(row.ip_address || ''),
            macAddress: String(row.mac_address || ''),
            port: Number(row.tcp_port) || 9100,
            location: String(row.location || ''),
            isApplicationPrinter: printerIndexes.has(id),
            source: 'database'
        };
        if (printerIndexes.has(id)) printers[printerIndexes.get(id)] = printer;
        else {
            printerIndexes.set(id, printers.length);
            printers.push(printer);
        }
    }
    return printers;
}

async function getPrinterConfig(connection, value) {
    const printerId = normalizePrinterId(value);
    if (!printerId) return null;
    const serverConfig = printerSettings.getPrinterConfig(printerId);
    let rows;
    try {
        [rows] = await connection.execute(
            'SELECT printer_id, printer_name, printer_model, ip_address, mac_address, tcp_port ' +
            'FROM printer_devices WHERE printer_id = ? LIMIT 1',
            [printerId]
        );
    } catch (error) {
        // Keep the established A-D printer path available if the optional
        // database override table is unavailable during a deployment.
        if (serverConfig) return serverConfig;
        throw error;
    }
    if (rows.length) {
        const row = rows[0];
        return {
            ID: row.printer_id,
            NAME: row.printer_name,
            MODEL: row.printer_model,
            IP: row.ip_address,
            MAC: row.mac_address,
            PORT: Number(row.tcp_port) || 9100
        };
    }
    return serverConfig;
}

function createPrinterId(existingIds = new Set()) {
    // Keep user-added printer IDs short and readable. Application-configured
    // printers retain their established A-D identifiers; added devices use
    // 001, 002, etc.
    let highestNumber = 0;
    for (const existingId of existingIds) {
        const match = /^PRINTER_(\d+)$/.exec(String(existingId || '').trim().toUpperCase());
        if (match) highestNumber = Math.max(highestNumber, Number(match[1]));
    }

    let nextNumber = highestNumber + 1;
    let printerId;
    do {
        printerId = 'PRINTER_' + String(nextNumber).padStart(3, '0');
        nextNumber += 1;
    } while (existingIds.has(printerId));
    return printerId;
}

function toPublicAssignments(assignments, printers = getConfiguredPrinters()) {
    const printersById = new Map(printers.map(printer => [printer.id, printer]));
    const publicAssignments = {};
    for (const workflow of Object.values(WORKFLOWS)) {
        const printerId = assignments[workflow.key] || null;
        const printer = printerId ? printersById.get(printerId) : null;
        publicAssignments[workflow.key] = {
            workflow: workflow.key,
            label: workflow.label,
            description: workflow.description,
            printerId,
            printerLetter: printer ? printer.letter : null,
            printerName: printer ? printer.name : null
        };
    }
    return publicAssignments;
}

module.exports = {
    WORKFLOWS,
    normalizePrinterId,
    loadWorkflowPrinterAssignments,
    getAssignedPrinterId,
    getConfiguredPrinters,
    loadConfiguredPrinters,
    getPrinterConfig,
    createPrinterId,
    toPublicAssignments
};
