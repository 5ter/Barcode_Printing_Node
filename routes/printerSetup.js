const express = require('express');
const path = require('path');
const db = require('../db/root');
const logger = require('../utils/logger');
const {
    WORKFLOWS,
    normalizePrinterId,
    loadWorkflowPrinterAssignments,
    getConfiguredPrinters,
    toPublicAssignments
} = require('../utils/workflowPrinterAssignments');

const router = express.Router();

router.get('/printer-setup', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, '..', 'views', 'printerSetup.html'));
});

router.get('/api/printer-setup/assignments', async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        const assignments = await loadWorkflowPrinterAssignments(connection);
        return res.json({
            status: 'success',
            printers: getConfiguredPrinters(),
            assignments: toPublicAssignments(assignments)
        });
    } catch (error) {
        logger.error('Could not load workflow printer assignments:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Could not load printer assignments. Confirm the workflow_printer_assignments migration has been applied.'
        });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/api/printer-setup/assignments', async (req, res) => {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'standardPrinterId') ||
        !Object.prototype.hasOwnProperty.call(body, 'arnPrinterId')) {
        return res.status(400).json({
            status: 'error',
            message: 'Send both workflow assignments. Use null or an empty value for an unassigned workflow.'
        });
    }

    const parseAssignment = value => {
        if (value === null || value === undefined || String(value).trim() === '') {
            return { valid: true, printerId: null };
        }
        const printerId = normalizePrinterId(value);
        return { valid: Boolean(printerId), printerId };
    };
    const standardAssignment = parseAssignment(body.standardPrinterId);
    const arnAssignment = parseAssignment(body.arnPrinterId);
    if (!standardAssignment.valid || !arnAssignment.valid) {
        return res.status(400).json({
            status: 'error',
            message: 'Choose a configured printer or leave the workflow unassigned.'
        });
    }

    const standardPrinterId = standardAssignment.printerId;
    const arnPrinterId = arnAssignment.printerId;
    if (standardPrinterId && standardPrinterId === arnPrinterId) {
        return res.status(400).json({
            status: 'error',
            message: 'Assign different printers to Standard and ARN workflows.'
        });
    }

    let connection;
    let transactionOpen = false;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;

        const [currentRows] = await connection.execute(
            'SELECT workflow_key, printer_id FROM workflow_printer_assignments FOR UPDATE'
        );
        const currentAssignments = {};
        for (const row of currentRows) {
            currentAssignments[String(row.workflow_key).toUpperCase()] = normalizePrinterId(row.printer_id);
        }

        if (currentAssignments[WORKFLOWS.ARN.key] !== arnPrinterId) {
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

        await connection.execute('DELETE FROM workflow_printer_assignments');
        await connection.execute(
            'INSERT INTO workflow_printer_assignments (workflow_key, printer_id) VALUES (?, ?)',
            [WORKFLOWS.STANDARD.key, standardPrinterId]
        );
        await connection.execute(
            'INSERT INTO workflow_printer_assignments (workflow_key, printer_id) VALUES (?, ?)',
            [WORKFLOWS.ARN.key, arnPrinterId]
        );
        await connection.commit();
        transactionOpen = false;

        return res.json({
            status: 'success',
            message: 'Workflow printer assignments saved.',
            assignments: toPublicAssignments({
                [WORKFLOWS.STANDARD.key]: standardPrinterId,
                [WORKFLOWS.ARN.key]: arnPrinterId
            })
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

router.get('/printer-setup.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/javascript').sendFile(path.join(__dirname, '..', 'views', 'printerSetup.js'));
});

module.exports = router;
