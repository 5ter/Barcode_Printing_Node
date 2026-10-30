const express = require('express');
const net = require('net');
const path = require('path');
const db = require('../db/root');
const printerSettings = require('../config/printerSetting');
const logger = require('../utils/logger');
const { requirePageAccess } = require('../utils/auth');
const {
    WORKFLOWS,
    normalizePrinterId,
    loadWorkflowPrinterAssignments,
    loadConfiguredPrinters,
    createPrinterId,
    toPublicAssignments
} = require('../utils/workflowPrinterAssignments');

const router = express.Router();

function readPrinterDetails(body) {
    const name = String(body.name || '').trim();
    const model = String(body.model || '').trim();
    const location = String(body.location || '').trim();
    const ipAddress = String(body.ipAddress || '').trim();
    const suppliedMacAddress = String(body.macAddress || '').trim();
    const macAddress = suppliedMacAddress ? suppliedMacAddress.replace(/-/g, ':').toUpperCase() : null;
    const port = Number(body.port);

    if (!name || name.length > 120 || /[\x00-\x1F\x7F]/.test(name)) {
        return { error: 'Enter a printer name of 1 to 120 characters.' };
    }
    if (model.length > 120) {
        return { error: 'Printer model must be 120 characters or fewer.' };
    }
    if (location.length > 160 || /[\x00-\x1F\x7F]/.test(location)) {
        return { error: 'Printer location must be 160 characters or fewer.' };
    }
    if (net.isIP(ipAddress) !== 4) {
        return { error: 'Enter a valid IPv4 address for the printer.' };
    }
    if (macAddress && !/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(macAddress)) {
        return { error: 'Enter a valid MAC address or leave it blank.' };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: 'TCP port must be a number from 1 to 65535.' };
    }

    return {
        values: {
            name,
            model,
            location,
            ipAddress,
            macAddress,
            port
        }
    };
}

async function arnWorkflowHasActiveWork(connection, printerId) {
    const [assignmentRows] = await connection.execute(
        'SELECT printer_id FROM workflow_printer_assignments WHERE workflow_key = ?',
        [WORKFLOWS.ARN.key]
    );
    const assignedPrinterId = assignmentRows.length ? normalizePrinterId(assignmentRows[0].printer_id) : null;
    if (assignedPrinterId !== printerId) return false;

    const [activeRows] = await connection.execute(
        'SELECT ' +
            '(SELECT COUNT(*) FROM arn_station_lock WHERE printer_id = ? AND mo IS NOT NULL) + ' +
            '(SELECT COUNT(*) FROM arn_cartons WHERE printer_id = ? AND status IN (?, ?, ?)) AS active_count',
        [printerId, printerId, 'OPEN', 'PRINTING', 'PRINT_FAILED']
    );
    return Number(activeRows[0] && activeRows[0].active_count || 0) > 0;
}

router.get('/printer-setup', requirePageAccess('printer'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, '..', 'views', 'printerSetup.html'));
});

// Workstation pages need the current route to display the assigned printer;
// this read-only summary intentionally omits network addresses and ports.
router.get('/api/workflow-printers', requirePageAccess('standard'), async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        const printers = await loadConfiguredPrinters(connection);
        const assignments = await loadWorkflowPrinterAssignments(connection);
        const publicAssignments = toPublicAssignments(assignments, printers);
        return res.json({
            status: 'success',
            assignments: Object.fromEntries(Object.entries(publicAssignments).map(([key, value]) => [key, {
                workflow: value.workflow,
                label: value.label,
                printerId: value.printerId,
                printerLetter: value.printerLetter,
                printerName: value.printerName
            }]))
        });
    } catch (error) {
        logger.error('Could not load public workflow printer routing:', error);
        return res.status(500).json({ status: 'error', message: 'Workflow printer routing is unavailable.' });
    } finally {
        if (connection) connection.release();
    }
});

router.get('/api/printer-setup/assignments', requirePageAccess('printer'), async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        const printers = await loadConfiguredPrinters(connection);
        const assignments = await loadWorkflowPrinterAssignments(connection);
        return res.json({
            status: 'success',
            printers,
            assignments: toPublicAssignments(assignments, printers)
        });
    } catch (error) {
        logger.error('Could not load workflow printer assignments:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Could not load printer inventory. Confirm the workflow assignment and printer-device migrations have been applied.'
        });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/api/printer-setup/printers', requirePageAccess('printer'), async (req, res) => {
    const parsed = readPrinterDetails(req.body || {});
    if (parsed.error) return res.status(400).json({ status: 'error', message: parsed.error });
    const { name, model, location, ipAddress, macAddress, port } = parsed.values;

    let connection;
    try {
        connection = await db.getConnection();
        const printers = await loadConfiguredPrinters(connection);
        if (printers.some(printer => printer.ipAddress === ipAddress && Number(printer.port) === port)) {
            return res.status(409).json({
                status: 'error',
                message: 'A printer with this IP address and TCP port is already configured.'
            });
        }

        const existingIds = new Set(printers.map(printer => printer.id));
        const printerId = createPrinterId(existingIds);

        await connection.execute(
            'INSERT INTO printer_devices (printer_id, printer_name, location, printer_model, ip_address, mac_address, tcp_port) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            [printerId, name, location || null, model || null, ipAddress, macAddress, port]
        );

        return res.status(201).json({
            status: 'success',
            message: 'Printer added as Unassigned. Use Edit Printer to route it when ready.',
            printer: {
                id: printerId,
                letter: printerId.replace(/^PRINTER_/, ''),
                name,
                model,
                location,
                ipAddress,
                macAddress: macAddress || '',
                port
            }
        });
    } catch (error) {
        logger.error('Could not add printer device:', error);
        if (error.code === 'ER_DUP_ENTRY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ status: 'error', message: 'That printer or network endpoint is already registered.' });
        }
        return res.status(500).json({
            status: 'error',
            message: 'Could not add printer. Confirm the printer-device migrations have been applied.'
        });
    } finally {
        if (connection) connection.release();
    }
});

router.put('/api/printer-setup/printers/:printerId', requirePageAccess('printer'), async (req, res) => {
    const printerId = normalizePrinterId(req.params.printerId);
    if (!printerId) {
        return res.status(400).json({ status: 'error', message: 'Choose a valid printer.' });
    }
    const parsed = readPrinterDetails(req.body || {});
    if (parsed.error) return res.status(400).json({ status: 'error', message: parsed.error });
    const { name, model, location, ipAddress, macAddress, port } = parsed.values;
    const workflowKey = String(req.body && req.body.workflowKey || '').trim().toUpperCase();
    if (![WORKFLOWS.STANDARD.key, WORKFLOWS.ARN.key, 'UNASSIGNED'].includes(workflowKey)) {
        return res.status(400).json({
            status: 'error',
            message: 'Choose Standard, ARN, or Unassigned for this printer workflow.'
        });
    }

    let connection;
    let transactionOpen = false;
    try {
        connection = await db.getConnection();
        const printers = await loadConfiguredPrinters(connection);
        if (!printers.some(printer => printer.id === printerId)) {
            return res.status(404).json({ status: 'error', message: 'That printer is no longer in the configured inventory.' });
        }
        if (printers.some(printer => printer.id !== printerId && printer.ipAddress === ipAddress && Number(printer.port) === port)) {
            return res.status(409).json({
                status: 'error',
                message: 'Another configured printer already uses this IP address and TCP port.'
            });
        }

        const currentPrinter = printers.find(printer => printer.id === printerId);
        const connectionChanged = currentPrinter.ipAddress !== ipAddress || Number(currentPrinter.port) !== port;
        if (connectionChanged && await arnWorkflowHasActiveWork(connection, printerId)) {
            return res.status(409).json({
                status: 'error',
                message: 'The ARN printer network address cannot be changed while an ARN MO/station lock or unfinished carton exists. Finish and unlock the MO first.'
            });
        }

        await connection.beginTransaction();
        transactionOpen = true;

        const [currentRows] = await connection.execute(
            'SELECT workflow_key, printer_id FROM workflow_printer_assignments FOR UPDATE'
        );
        const currentAssignments = {};
        for (const row of currentRows) {
            currentAssignments[String(row.workflow_key).toUpperCase()] = normalizePrinterId(row.printer_id);
        }
        const nextAssignments = { ...currentAssignments };
        for (const workflow of Object.values(WORKFLOWS)) {
            if (nextAssignments[workflow.key] === printerId) {
                nextAssignments[workflow.key] = null;
            }
        }
        if (workflowKey !== 'UNASSIGNED') {
            nextAssignments[workflowKey] = printerId;
        }

        if (currentAssignments[WORKFLOWS.ARN.key] !== nextAssignments[WORKFLOWS.ARN.key]) {
            const [activeRows] = await connection.execute(
                'SELECT ' +
                    '(SELECT COUNT(*) FROM arn_station_lock WHERE mo IS NOT NULL) + ' +
                    '(SELECT COUNT(*) FROM arn_cartons WHERE status IN (?, ?, ?)) AS active_count',
                ['OPEN', 'PRINTING', 'PRINT_FAILED']
            );
            if (Number(activeRows[0] && activeRows[0].active_count || 0) > 0) {
                await connection.rollback();
                transactionOpen = false;
                return res.status(409).json({
                    status: 'error',
                    message: 'The ARN printer cannot be reassigned while an ARN MO/station lock or an unfinished carton exists. Finish and unlock the MO first so its saved station state is not stranded.'
                });
            }
        }

        await connection.execute(
            'INSERT INTO printer_devices (printer_id, printer_name, location, printer_model, ip_address, mac_address, tcp_port) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE printer_name = VALUES(printer_name), location = VALUES(location), ' +
            'printer_model = VALUES(printer_model), ip_address = VALUES(ip_address), ' +
            'mac_address = VALUES(mac_address), tcp_port = VALUES(tcp_port)',
            [printerId, name, location || null, model || null, ipAddress, macAddress, port]
        );

        const arnPrinterId = nextAssignments[WORKFLOWS.ARN.key];
        if (arnPrinterId) {
            await connection.execute(
                'INSERT INTO arn_station_lock (printer_id) ' +
                'SELECT ? WHERE NOT EXISTS (' +
                'SELECT 1 FROM arn_station_lock WHERE printer_id = ?' +
                ')',
                [arnPrinterId, arnPrinterId]
            );
        }
        await connection.execute('DELETE FROM workflow_printer_assignments');
        await connection.execute(
            'INSERT INTO workflow_printer_assignments (workflow_key, printer_id) VALUES (?, ?)',
            [WORKFLOWS.STANDARD.key, nextAssignments[WORKFLOWS.STANDARD.key] || null]
        );
        await connection.execute(
            'INSERT INTO workflow_printer_assignments (workflow_key, printer_id) VALUES (?, ?)',
            [WORKFLOWS.ARN.key, nextAssignments[WORKFLOWS.ARN.key] || null]
        );
        await connection.commit();
        transactionOpen = false;

        return res.json({
            status: 'success',
            message: 'Printer details and workflow assignment saved together.',
            printer: {
                id: printerId,
                letter: printerId.replace(/^PRINTER_/, ''),
                name,
                model,
                location,
                ipAddress,
                macAddress: macAddress || '',
                port
            },
            assignments: toPublicAssignments(nextAssignments, printers.map(printer =>
                printer.id === printerId ? { ...printer, name, model, location, ipAddress, macAddress, port } : printer
            ))
        });
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not save printer configuration:', error);
        if (error.code === 'ER_DUP_ENTRY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ status: 'error', message: 'Another printer already uses this network endpoint.' });
        }
        return res.status(500).json({
            status: 'error',
            message: 'Could not save the printer configuration. Confirm the printer-device and workflow-assignment migrations have been applied.'
        });
    } finally {
        if (connection) connection.release();
    }
});

router.delete('/api/printer-setup/printers/:printerId', requirePageAccess('printer'), async (req, res) => {
    const printerId = normalizePrinterId(req.params.printerId);
    if (!printerId || !printerSettings.getPrinterConfig(printerId)) {
        return res.status(400).json({ status: 'error', message: 'Only server-defined printers can restore server values.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        const printers = await loadConfiguredPrinters(connection);
        const currentPrinter = printers.find(printer => printer.id === printerId);
        const serverPrinter = printerSettings.getPrinterConfig(printerId);
        if (printers.some(printer => printer.id !== printerId && printer.ipAddress === serverPrinter.IP &&
            Number(printer.port) === Number(serverPrinter.PORT))) {
            return res.status(409).json({
                status: 'error',
                message: 'The server-configured IP address and port are already in use by another configured printer.'
            });
        }
        if (currentPrinter && (currentPrinter.ipAddress !== serverPrinter.IP ||
            Number(currentPrinter.port) !== Number(serverPrinter.PORT)) &&
            await arnWorkflowHasActiveWork(connection, printerId)) {
            return res.status(409).json({
                status: 'error',
                message: 'The ARN printer cannot be restored to its server address while an ARN MO/station lock or unfinished carton exists.'
            });
        }

        await connection.execute('DELETE FROM printer_devices WHERE printer_id = ?', [printerId]);
        return res.json({
            status: 'success',
            message: 'The printer has been restored to its server-configured values. Its workflow assignment was not changed.'
        });
    } catch (error) {
        logger.error('Could not restore printer defaults:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Could not restore server printer values. Confirm the printer-device migrations have been applied.'
        });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/api/printer-setup/assignments', requirePageAccess('printer'), async (req, res) => {
    const body = req.body || {};
    const printerId = normalizePrinterId(body.printerId);
    const workflowKey = String(body.workflowKey || '').trim().toUpperCase();
    if (!printerId || ![WORKFLOWS.STANDARD.key, WORKFLOWS.ARN.key, 'UNASSIGNED'].includes(workflowKey)) {
        return res.status(400).json({
            status: 'error',
            message: 'Choose a configured printer and assign it to Standard, ARN, or Unassigned.'
        });
    }

    let connection;
    let transactionOpen = false;
    try {
        connection = await db.getConnection();
        const printers = await loadConfiguredPrinters(connection);
        if (!printers.some(printer => printer.id === printerId)) {
            return res.status(400).json({ status: 'error', message: 'Choose a printer that is present in the configured inventory.' });
        }
        await connection.beginTransaction();
        transactionOpen = true;

        const [currentRows] = await connection.execute(
            'SELECT workflow_key, printer_id FROM workflow_printer_assignments FOR UPDATE'
        );
        const currentAssignments = {};
        for (const row of currentRows) {
            currentAssignments[String(row.workflow_key).toUpperCase()] = normalizePrinterId(row.printer_id);
        }

        const nextAssignments = { ...currentAssignments };
        for (const workflow of Object.values(WORKFLOWS)) {
            if (nextAssignments[workflow.key] === printerId) {
                nextAssignments[workflow.key] = null;
            }
        }
        if (workflowKey !== 'UNASSIGNED') {
            nextAssignments[workflowKey] = printerId;
        }

        if (currentAssignments[WORKFLOWS.ARN.key] !== nextAssignments[WORKFLOWS.ARN.key]) {
            const [activeRows] = await connection.execute(
                'SELECT ' +
                    '(SELECT COUNT(*) FROM arn_station_lock WHERE mo IS NOT NULL) + ' +
                    '(SELECT COUNT(*) FROM arn_cartons WHERE status IN (?, ?, ?)) AS active_count',
                ['OPEN', 'PRINTING', 'PRINT_FAILED']
            );
            if (Number(activeRows[0] && activeRows[0].active_count || 0) > 0) {
                await connection.rollback();
                transactionOpen = false;
                return res.status(409).json({
                    status: 'error',
                    message: 'The ARN printer cannot be reassigned while an ARN MO/station lock or an unfinished carton exists. Finish and unlock the MO first so its saved station state is not stranded.'
                });
            }
        }

        // An ARN station is the persisted job/carton state for its assigned
        // printer. Provision it as part of assigning the printer, rather than
        // expecting an operator or administrator to create a database row.
        const arnPrinterId = nextAssignments[WORKFLOWS.ARN.key];
        if (arnPrinterId) {
            await connection.execute(
                'INSERT INTO arn_station_lock (printer_id) ' +
                'SELECT ? WHERE NOT EXISTS (' +
                'SELECT 1 FROM arn_station_lock WHERE printer_id = ?' +
                ')',
                [arnPrinterId, arnPrinterId]
            );
        }

        await connection.execute('DELETE FROM workflow_printer_assignments');
        await connection.execute(
            'INSERT INTO workflow_printer_assignments (workflow_key, printer_id) VALUES (?, ?)',
            [WORKFLOWS.STANDARD.key, nextAssignments[WORKFLOWS.STANDARD.key] || null]
        );
        await connection.execute(
            'INSERT INTO workflow_printer_assignments (workflow_key, printer_id) VALUES (?, ?)',
            [WORKFLOWS.ARN.key, nextAssignments[WORKFLOWS.ARN.key] || null]
        );
        await connection.commit();
        transactionOpen = false;

        return res.json({
            status: 'success',
            message: 'Printer workflow assignment saved.',
            assignments: toPublicAssignments(nextAssignments, printers)
        });
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not save workflow printer assignments:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Could not save printer assignments. Check the database connection and workflow-printer migration.'
        });
    } finally {
        if (connection) connection.release();
    }
});

router.get('/printer-setup.js', requirePageAccess('printer'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/javascript').sendFile(path.join(__dirname, '..', 'views', 'printerSetup.js'));
});

module.exports = router;
