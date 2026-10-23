const express = require('express');
const path = require('path');
const db = require('../db/root');
const logger = require('../utils/logger');
const { requireRoles } = require('../utils/auth');
const {
    WORKFLOWS,
    normalizePrinterId,
    loadWorkflowPrinterAssignments,
    getConfiguredPrinters,
    toPublicAssignments
} = require('../utils/workflowPrinterAssignments');

const router = express.Router();

router.get('/printer-setup', requireRoles(['ADMIN']), (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, '..', 'views', 'printerSetup.html'));
});

// Workstation pages need the current route to display the assigned printer;
// this read-only summary intentionally omits network addresses and ports.
router.get('/api/workflow-printers', async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        const assignments = await loadWorkflowPrinterAssignments(connection);
        const publicAssignments = toPublicAssignments(assignments);
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

router.get('/api/printer-setup/assignments', requireRoles(['ADMIN']), async (req, res) => {
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

router.post('/api/printer-setup/assignments', requireRoles(['ADMIN']), async (req, res) => {
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
            assignments: toPublicAssignments(nextAssignments)
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

router.get('/printer-setup.js', requireRoles(['ADMIN']), (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/javascript').sendFile(path.join(__dirname, '..', 'views', 'printerSetup.js'));
});

module.exports = router;
