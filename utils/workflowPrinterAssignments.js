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
    return Object.prototype.hasOwnProperty.call(printerSettings.PRINTERS, printerId)
        ? printerId
        : null;
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
        name: config.NAME
    }));
}

function toPublicAssignments(assignments) {
    const printersById = new Map(getConfiguredPrinters().map(printer => [printer.id, printer]));
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
    toPublicAssignments
};
