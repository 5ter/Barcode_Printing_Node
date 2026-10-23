const express = require('express');
const path = require('path');
const db = require('../db/root');
const logger = require('../utils/logger');
const getWWYY = require('../utils/dateTime');
const { printLabel_arn } = require('../utils/printer');
const { generateArnLabel } = require('../utils/arn_label');
const arnLabelSettings = require('../config/arnLabelSetting');
const { getAssignedPrinterId, getPrinterConfig } = require('../utils/workflowPrinterAssignments');

const router = express.Router();
const setupPage = path.join(__dirname, '..', 'views', 'arn', 'setup.html');
const scanPage = path.join(__dirname, '..', 'views', 'arn', 'scan.html');
const workflowScript = path.join(__dirname, '..', 'views', 'arn', 'workflow.js');

router.get('/setup', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(setupPage);
});

router.get('/scan', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(scanPage);
});

router.get('/workflow.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('application/javascript').sendFile(workflowScript);
});

function printerLetter(printerId) {
    return printerId.replace(/^PRINTER_/, '');
}

function safeCount(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

async function loadStationState(connection, printerId) {
    const [lockRows] = await connection.execute(
        'SELECT printer_id, mo, manufacturer_part_no, arn_part_no, box_capacity, purchase_order, current_carton_id, locked_at FROM arn_station_lock WHERE printer_id = ?',
        [printerId]
    );
    if (!lockRows.length || !lockRows[0].mo) {
        return { active: false, printer: printerLetter(printerId), printerId };
    }

    const lock = lockRows[0];
    if (!lock.current_carton_id) {
        return {
            active: true,
            printer: printerLetter(printerId),
            printerId,
            lock,
            carton: null,
            scans: []
        };
    }

    const [cartonRows] = await connection.execute(
        'SELECT id, printer_id, mo, manufacturer_part_no, arn_part_no, purchase_order, box_capacity, scanned_count, status, label_history_id, created_at, sealed_at FROM arn_cartons WHERE id = ?',
        [lock.current_carton_id]
    );
    if (!cartonRows.length) {
        return {
            active: true,
            printer: printerLetter(printerId),
            printerId,
            lock,
            carton: null,
            scans: [],
            error: 'The saved station lock points to a carton record that is missing.'
        };
    }

    const carton = cartonRows[0];
    const [scans] = await connection.execute(
        'SELECT id, scanned_content, scanned_at FROM arn_carton_scans WHERE carton_id = ? AND removed_at IS NULL ORDER BY id DESC',
        [carton.id]
    );
    let printHistory = null;
    if (carton.label_history_id) {
        const [historyRows] = await connection.execute(
            'SELECT id, label_content, quantity, print_status, retry_count, last_error FROM arn_label_print_history WHERE id = ?',
            [carton.label_history_id]
        );
        printHistory = historyRows[0] || null;
    }

    return {
        active: true,
        printer: printerLetter(printerId),
        printerId,
        lock,
        carton,
        scans,
        printHistory
    };
}

async function createCarton(connection, printerId, data) {
    const [insertResult] = await connection.execute(
        'INSERT INTO arn_cartons (printer_id, mo, manufacturer_part_no, arn_part_no, purchase_order, box_capacity, scanned_count, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        [printerId, data.mo, data.manufacturer_part_no, data.arn_part_no, data.purchase_order, data.box_capacity, 'OPEN']
    );
    return String(insertResult.insertId);
}

async function createPendingPrintJob(connection, carton, actualQuantity) {
    const dateCode = getWWYY.getWWYY();
    await connection.execute(
        'INSERT INTO arn_label_part_sequence (manufacturer_part_no, date_code, last_item_no) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_item_no = last_item_no + 1',
        [carton.manufacturer_part_no, dateCode]
    );
    const [sequenceRows] = await connection.execute(
        'SELECT last_item_no FROM arn_label_part_sequence WHERE manufacturer_part_no = ? AND date_code = ? FOR UPDATE',
        [carton.manufacturer_part_no, dateCode]
    );
    const itemNo = Number(sequenceRows[0] && sequenceRows[0].last_item_no);
    if (!Number.isSafeInteger(itemNo) || itemNo < 1) {
        throw new Error('Invalid ARN sequence value for Manufacturer Part No. ' + carton.manufacturer_part_no);
    }

    const labelReference = dateCode + '-' + itemNo.toString().padStart(6, '0');
    const labelPayload = generateArnLabel({
        arnPartNumber: carton.arn_part_no,
        quantity: actualQuantity,
        manufacturerPartNumber: carton.manufacturer_part_no,
        purchaseOrder: carton.purchase_order,
        dateCode,
        itemNo,
        manufacturerName: arnLabelSettings.MANUFACTURER_NAME,
        madeInText: arnLabelSettings.MADE_IN_TEXT
    });
    const [historyInsert] = await connection.execute(
        'INSERT INTO arn_label_print_history (mo, arn_part_no, quantity, manufacturer_part_no, purchase_order, date_code, item_no, label_content, printer_id, label_payload, print_status, carton_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            carton.mo,
            carton.arn_part_no,
            actualQuantity,
            carton.manufacturer_part_no,
            carton.purchase_order,
            dateCode,
            itemNo,
            labelReference,
            carton.printer_id,
            labelPayload,
            'PENDING',
            carton.id
        ]
    );
    const historyId = String(historyInsert.insertId);
    await connection.execute(
        'UPDATE arn_cartons SET status = ?, scanned_count = ?, label_history_id = ? WHERE id = ?',
        ['PRINTING', actualQuantity, historyId, carton.id]
    );

    return {
        cartonId: String(carton.id),
        historyId,
        printerId: carton.printer_id,
        labelReference,
        labelPayload,
        quantity: actualQuantity
    };
}

async function transmitPrintJob(job) {
    let connection;
    try {
        connection = await db.getConnection();
        const printerConfig = await getPrinterConfig(connection, job.printerId);
        if (!printerConfig) throw new Error('Printer configuration for ' + job.printerId + ' is missing.');
        await printLabel_arn(job.labelPayload, printerConfig.IP, printerConfig.PORT);
        await connection.execute(
            'UPDATE arn_label_print_history SET print_status = ?, last_error = NULL WHERE id = ?',
            ['SENT', job.historyId]
        );
        await connection.execute(
            'UPDATE arn_cartons SET status = ?, sealed_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['SEALED', job.cartonId]
        );
        logger.log('ARN carton ' + job.cartonId + ' label ' + job.labelReference + ' sent to ' + job.printerId + '.');
        return { success: true };
    } catch (error) {
        try {
            if (!connection) connection = await db.getConnection();
            await connection.execute(
                'UPDATE arn_label_print_history SET print_status = ?, last_error = ? WHERE id = ?',
                ['FAILED', String(error.message || error).slice(0, 4000), job.historyId]
            );
            await connection.execute(
                'UPDATE arn_cartons SET status = ? WHERE id = ?',
                ['PRINT_FAILED', job.cartonId]
            );
        } catch (statusError) {
            logger.error('Could not save ARN carton print failure:', statusError);
        }
        logger.error('ARN carton label send failed for ' + job.labelReference + ': ' + error.message);
        return { success: false, error };
    } finally {
        if (connection) connection.release();
    }
}

async function getArnWorkflowPrinter(res) {
    let connection;
    try {
        connection = await db.getConnection();
        const printerId = await getAssignedPrinterId(connection, 'ARN');
        if (!printerId) {
            res.status(503).json({
                status: 'error',
                message: 'No printer is assigned to the ARN workflow. Configure one on the Printer Setup page.'
            });
            return null;
        }
        return printerId;
    } catch (error) {
        logger.error('Could not resolve the assigned ARN printer:', error);
        res.status(500).json({
            status: 'error',
            message: 'Could not resolve the ARN printer assignment. Check the printer setup migration and database.'
        });
        return null;
    } finally {
        if (connection) connection.release();
    }
}

router.get('/api/state', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    let connection;
    try {
        connection = await db.getConnection();
        return res.json({ status: 'success', state: await loadStationState(connection, printerId) });
    } catch (error) {
        logger.error('Could not load ARN station state:', error);
        return res.status(500).json({ status: 'error', message: 'Could not load this printer’s ARN station state.' });
    } finally {
        if (connection) connection.release();
    }
});

// The Step 1 history panel is deliberately limited to the current ARN
// station. This keeps its Reprint actions tied to the printer that created
// the carton and prevents an old line's labels appearing at a new station.
router.get('/api/recent-cartons', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    let connection;
    try {
        connection = await db.getConnection();
        const [rows] = await connection.execute(
            'SELECT c.id, c.mo, c.manufacturer_part_no, c.arn_part_no, c.box_capacity, c.scanned_count, c.status, ' +
            'c.created_at, c.sealed_at, c.label_history_id, ' +
            'h.id AS print_history_id, h.label_content AS label_reference, h.quantity AS printed_quantity, ' +
            'h.print_status, h.retry_count, h.last_retry_at, h.last_error, ' +
            'CASE WHEN h.label_payload IS NULL OR h.label_payload = \'\' THEN 0 ELSE 1 END AS has_saved_payload ' +
            'FROM arn_cartons c ' +
            'LEFT JOIN arn_label_print_history h ON h.id = c.label_history_id ' +
            'WHERE c.printer_id = ? ' +
            'ORDER BY c.id DESC LIMIT 10',
            [printerId]
        );
        const cartons = rows.map(row => ({
            id: String(row.id),
            mo: row.mo,
            manufacturerPartNo: row.manufacturer_part_no,
            arnPartNo: row.arn_part_no,
            boxCapacity: safeCount(row.box_capacity),
            scannedCount: safeCount(row.scanned_count),
            status: row.status,
            createdAt: row.created_at,
            sealedAt: row.sealed_at,
            printHistoryId: row.print_history_id ? String(row.print_history_id) : null,
            labelReference: row.label_reference || null,
            printedQuantity: row.printed_quantity == null ? null : safeCount(row.printed_quantity),
            printStatus: row.print_status || null,
            retryCount: safeCount(row.retry_count),
            lastRetryAt: row.last_retry_at || null,
            lastError: row.last_error || null,
            canReprint: row.status === 'SEALED' && Boolean(row.print_history_id) && Number(row.has_saved_payload) === 1
        }));
        return res.json({ status: 'success', cartons });
    } catch (error) {
        logger.error('Could not load recent ARN cartons:', error);
        return res.status(500).json({ status: 'error', message: 'Could not load recent cartons for this ARN station.' });
    } finally {
        if (connection) connection.release();
    }
});

router.get('/api/lookup', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    const manufacturerPartNo = String(req.query.manufacturerPartNo || '').trim();
    if (!manufacturerPartNo) {
        return res.status(400).json({ status: 'error', message: 'Manufacturer Part No. is required.' });
    }
    let connection;
    try {
        connection = await db.getConnection();
        const [rows] = await connection.execute(
            'SELECT arn_part_no, quantity, manufacturer_part_no, purchase_order FROM arn_label_data WHERE manufacturer_part_no = ?',
            [manufacturerPartNo]
        );
        if (!rows.length) {
            return res.status(404).json({ status: 'error', message: 'No ARN Excel row matches that Manufacturer Part No.' });
        }
        return res.json({ status: 'success', data: rows[0] });
    } catch (error) {
        logger.error('Could not look up ARN label data:', error);
        return res.status(500).json({ status: 'error', message: 'Could not look up the ARN workbook data.' });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/api/lock', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    const mo = String(req.body.mo || '').trim();
    const manufacturerPartNo = String(req.body.manufacturerPartNo || '').trim();
    if (!mo || !manufacturerPartNo) {
        return res.status(400).json({ status: 'error', message: 'MO and Manufacturer Part No. are required.' });
    }

    let connection;
    let transactionOpen = false;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [lockRows] = await connection.execute(
            'SELECT printer_id, mo, manufacturer_part_no, current_carton_id FROM arn_station_lock WHERE printer_id = ? FOR UPDATE',
            [printerId]
        );
        if (!lockRows.length) throw new Error('Station lock row is missing. Apply the ARN carton migration first.');
        const currentLock = lockRows[0];
        if (currentLock.mo) {
            const samePart = String(currentLock.manufacturer_part_no).toUpperCase() === manufacturerPartNo.toUpperCase();
            if (String(currentLock.mo) !== mo || !samePart) {
                await connection.rollback();
                transactionOpen = false;
                return res.status(409).json({
                    status: 'error',
                    message: 'This printer is already locked to MO ' + currentLock.mo + ' and part ' + currentLock.manufacturer_part_no + '. Resume it or finish its current carton before changing jobs.'
                });
            }
            await connection.commit();
            transactionOpen = false;
            const state = await loadStationState(connection, printerId);
            return res.json({ status: 'success', state, resumed: true });
        }

        const [arnRows] = await connection.execute(
            'SELECT arn_part_no, quantity, manufacturer_part_no, purchase_order FROM arn_label_data WHERE manufacturer_part_no = ?',
            [manufacturerPartNo]
        );
        if (!arnRows.length) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(404).json({
                status: 'error',
                message: 'No ARN Excel row matches that Manufacturer Part No. Check the part number and upload the current workbook.'
            });
        }

        const data = arnRows[0];
        const capacity = Number(data.quantity);
        if (!Number.isSafeInteger(capacity) || capacity < 1) {
            throw new Error('The ARN Excel Quantity is not a valid positive carton capacity.');
        }
        const cartonData = {
            mo,
            manufacturer_part_no: data.manufacturer_part_no,
            arn_part_no: data.arn_part_no,
            purchase_order: data.purchase_order,
            box_capacity: capacity
        };
        const cartonId = await createCarton(connection, printerId, cartonData);
        await connection.execute(
            'UPDATE arn_station_lock SET mo = ?, manufacturer_part_no = ?, arn_part_no = ?, box_capacity = ?, purchase_order = ?, current_carton_id = ?, locked_at = CURRENT_TIMESTAMP WHERE printer_id = ?',
            [mo, cartonData.manufacturer_part_no, cartonData.arn_part_no, capacity, cartonData.purchase_order, cartonId, printerId]
        );
        await connection.commit();
        transactionOpen = false;
        const state = await loadStationState(connection, printerId);
        logger.log('ARN station ' + printerId + ' locked to MO ' + mo + ' / part ' + manufacturerPartNo + '.');
        return res.status(201).json({ status: 'success', state });
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not lock ARN carton:', error);
        return res.status(500).json({ status: 'error', message: 'Could not lock the ARN job: ' + error.message });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/api/scan', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    const scannedContent = typeof req.body.content === 'string'
        ? req.body.content.replace(/[\r\n]+$/g, '')
        : '';
    if (!scannedContent.trim()) {
        return res.status(400).json({ status: 'error', message: 'A non-empty product barcode scan is required.' });
    }
    if (scannedContent.length > 2000) {
        return res.status(400).json({ status: 'error', message: 'The scanned barcode is longer than 2,000 characters.' });
    }

    let connection;
    let transactionOpen = false;
    let printJob = null;
    let scanId = null;
    let scannedCount = 0;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [lockRows] = await connection.execute(
            'SELECT current_carton_id, mo FROM arn_station_lock WHERE printer_id = ? FOR UPDATE',
            [printerId]
        );
        if (!lockRows.length || !lockRows[0].mo || !lockRows[0].current_carton_id) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This printer has no active ARN carton lock. Set up an MO and part first.' });
        }
        const [cartonRows] = await connection.execute(
            'SELECT * FROM arn_cartons WHERE id = ? FOR UPDATE',
            [lockRows[0].current_carton_id]
        );
        if (!cartonRows.length) throw new Error('The active carton record is missing.');
        const carton = cartonRows[0];
        if (carton.status !== 'OPEN') {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This carton is sealed or awaiting its ARN print. Proceed to a new carton before scanning.' });
        }
        const currentCount = safeCount(carton.scanned_count);
        const capacity = Number(carton.box_capacity);
        if (currentCount >= capacity) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'The carton is already at capacity.' });
        }

        const [insertResult] = await connection.execute(
            'INSERT INTO arn_carton_scans (carton_id, scanned_content) VALUES (?, ?)',
            [carton.id, scannedContent]
        );
        scanId = String(insertResult.insertId);
        scannedCount = currentCount + 1;
        await connection.execute(
            'UPDATE arn_cartons SET scanned_count = ? WHERE id = ?',
            [scannedCount, carton.id]
        );

        if (scannedCount === capacity) {
            printJob = await createPendingPrintJob(connection, carton, scannedCount);
        }
        await connection.commit();
        transactionOpen = false;
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not record ARN product scan:', error);
        return res.status(500).json({ status: 'error', message: 'Could not save this product scan: ' + error.message });
    } finally {
        if (connection) connection.release();
    }

    let printResult = null;
    if (printJob) printResult = await transmitPrintJob(printJob);
    const state = await getStateForResponse(printerId);
    if (printResult && !printResult.success) {
        return res.status(502).json({
            status: 'error',
            message: 'The carton is full, but ARN label printing failed. Retry the same saved label before proceeding.',
            scanId,
            scannedCount,
            printHistoryId: printJob.historyId,
            labelReference: printJob.labelReference,
            state
        });
    }
    return res.json({
        status: 'success',
        scanId,
        scannedCount,
        labelPrinted: Boolean(printJob),
        labelReference: printJob && printJob.labelReference,
        state
    });
});

router.post('/api/scan/remove', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    const scanId = String(req.body.scanId || '').trim();
    if (!/^[1-9][0-9]*$/.test(scanId)) {
        return res.status(400).json({ status: 'error', message: 'A valid scan record ID is required.' });
    }
    let connection;
    let transactionOpen = false;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [lockRows] = await connection.execute(
            'SELECT current_carton_id, mo FROM arn_station_lock WHERE printer_id = ? FOR UPDATE',
            [printerId]
        );
        if (!lockRows.length || !lockRows[0].mo || !lockRows[0].current_carton_id) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'There is no active carton to edit.' });
        }
        const [cartonRows] = await connection.execute(
            'SELECT status FROM arn_cartons WHERE id = ? FOR UPDATE',
            [lockRows[0].current_carton_id]
        );
        if (!cartonRows.length || cartonRows[0].status !== 'OPEN') {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'A full or sealed carton cannot be edited because its label has already been printed.' });
        }
        const [removeResult] = await connection.execute(
            'UPDATE arn_carton_scans SET removed_at = CURRENT_TIMESTAMP WHERE id = ? AND carton_id = ? AND removed_at IS NULL',
            [scanId, lockRows[0].current_carton_id]
        );
        if (!removeResult.affectedRows) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(404).json({ status: 'error', message: 'That active scan was not found in this carton.' });
        }
        await connection.execute(
            'UPDATE arn_cartons SET scanned_count = CASE WHEN scanned_count > 0 THEN scanned_count - 1 ELSE 0 END WHERE id = ?',
            [lockRows[0].current_carton_id]
        );
        await connection.commit();
        transactionOpen = false;
        return res.json({ status: 'success', state: await getStateForResponse(printerId) });
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not remove ARN product scan:', error);
        return res.status(500).json({ status: 'error', message: 'Could not remove the product scan: ' + error.message });
    } finally {
        if (connection) connection.release();
    }
});

async function getStateForResponse(printerId) {
    let connection;
    try {
        connection = await db.getConnection();
        return await loadStationState(connection, printerId);
    } finally {
        if (connection) connection.release();
    }
}

async function prepareCartonForPrint(req, res, printerId) {
    let connection;
    let transactionOpen = false;
    let printJob;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [lockRows] = await connection.execute(
            'SELECT current_carton_id, mo FROM arn_station_lock WHERE printer_id = ? FOR UPDATE',
            [printerId]
        );
        if (!lockRows.length || !lockRows[0].mo || !lockRows[0].current_carton_id) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This printer has no active carton.' });
        }
        const [cartonRows] = await connection.execute(
            'SELECT * FROM arn_cartons WHERE id = ? FOR UPDATE',
            [lockRows[0].current_carton_id]
        );
        if (!cartonRows.length) throw new Error('The active carton record is missing.');
        const carton = cartonRows[0];
        const actualQuantity = safeCount(carton.scanned_count);
        if (carton.status !== 'OPEN') {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This carton has already been completed or is awaiting print status.' });
        }
        if (actualQuantity === 0) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(400).json({ status: 'error', message: 'Cannot seal an empty carton.' });
        }
        printJob = await createPendingPrintJob(connection, carton, actualQuantity);
        await connection.commit();
        transactionOpen = false;
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not complete ARN carton:', error);
        return res.status(500).json({ status: 'error', message: 'Could not complete this carton: ' + error.message });
    } finally {
        if (connection) connection.release();
    }

    const printResult = await transmitPrintJob(printJob);
    const state = await getStateForResponse(printerId);
    if (!printResult.success) {
        return res.status(502).json({
            status: 'error',
            message: 'Carton completion was saved, but its ARN label did not print. Retry the saved label before proceeding.',
            printHistoryId: printJob.historyId,
            labelReference: printJob.labelReference,
            state
        });
    }
    return res.json({
        status: 'success',
        message: 'Carton sealed and ARN label printed.',
        printHistoryId: printJob.historyId,
        labelReference: printJob.labelReference,
        state
    });
}

router.post('/api/carton/complete', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    return prepareCartonForPrint(req, res, printerId);
});

router.post('/api/carton/next', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    let connection;
    let transactionOpen = false;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [lockRows] = await connection.execute(
            'SELECT * FROM arn_station_lock WHERE printer_id = ? FOR UPDATE',
            [printerId]
        );
        if (!lockRows.length || !lockRows[0].mo || !lockRows[0].current_carton_id) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This printer has no active MO/part lock.' });
        }
        const lock = lockRows[0];
        const [cartonRows] = await connection.execute(
            'SELECT status FROM arn_cartons WHERE id = ? FOR UPDATE',
            [lock.current_carton_id]
        );
        if (!cartonRows.length || cartonRows[0].status !== 'SEALED') {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'Print and seal the current carton before proceeding to the next one.' });
        }
        const newCartonId = await createCarton(connection, printerId, lock);
        await connection.execute(
            'UPDATE arn_station_lock SET current_carton_id = ? WHERE printer_id = ?',
            [newCartonId, printerId]
        );
        await connection.commit();
        transactionOpen = false;
        return res.json({ status: 'success', state: await getStateForResponse(printerId) });
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not open next ARN carton:', error);
        return res.status(500).json({ status: 'error', message: 'Could not open the next carton: ' + error.message });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/api/unlock', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    let connection;
    let transactionOpen = false;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [lockRows] = await connection.execute(
            'SELECT current_carton_id, mo FROM arn_station_lock WHERE printer_id = ? FOR UPDATE',
            [printerId]
        );
        if (lockRows.length && lockRows[0].mo && lockRows[0].current_carton_id) {
            const [cartonRows] = await connection.execute(
                'SELECT status, scanned_count FROM arn_cartons WHERE id = ? FOR UPDATE',
                [lockRows[0].current_carton_id]
            );
            if (cartonRows.length) {
                const carton = cartonRows[0];
                if (carton.status === 'OPEN' && safeCount(carton.scanned_count) > 0) {
                    await connection.rollback();
                    transactionOpen = false;
                    return res.status(409).json({ status: 'error', message: 'Complete and seal the current carton before changing the MO or part.' });
                }
                if (carton.status !== 'OPEN' && carton.status !== 'SEALED') {
                    await connection.rollback();
                    transactionOpen = false;
                    return res.status(409).json({ status: 'error', message: 'Resolve the pending ARN label print before changing the MO or part.' });
                }
            }
        }
        await connection.execute(
            'UPDATE arn_station_lock SET mo = NULL, manufacturer_part_no = NULL, arn_part_no = NULL, box_capacity = NULL, purchase_order = NULL, current_carton_id = NULL, locked_at = NULL WHERE printer_id = ?',
            [printerId]
        );
        await connection.commit();
        transactionOpen = false;
        return res.json({ status: 'success', state: await getStateForResponse(printerId) });
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not unlock ARN station:', error);
        return res.status(500).json({ status: 'error', message: 'Could not change the ARN job: ' + error.message });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/api/retry-label', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    const historyId = String(req.body.printHistoryId || '').trim();
    if (!/^[1-9][0-9]*$/.test(historyId)) {
        return res.status(400).json({ status: 'error', message: 'A valid ARN print history ID is required.' });
    }
    let connection;
    let transactionOpen = false;
    let job;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [historyRows] = await connection.execute(
            'SELECT id, label_content, label_payload, printer_id, carton_id, print_status FROM arn_label_print_history WHERE id = ? FOR UPDATE',
            [historyId]
        );
        if (!historyRows.length || !historyRows[0].carton_id) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(404).json({ status: 'error', message: 'The saved ARN carton print was not found.' });
        }
        const history = historyRows[0];
        if (history.printer_id !== printerId) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'Switch to the printer that owns this carton before retrying its label.' });
        }
        if (history.print_status === 'SENT') {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This ARN label was already sent. It will not be reprinted automatically.' });
        }
        if (!history.label_payload) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This saved carton has no printer payload and cannot be retried.' });
        }
        await connection.execute(
            'UPDATE arn_label_print_history SET retry_count = retry_count + 1, last_retry_at = CURRENT_TIMESTAMP, print_status = ?, last_error = NULL WHERE id = ?',
            ['PENDING', historyId]
        );
        await connection.execute('UPDATE arn_cartons SET status = ? WHERE id = ?', ['PRINTING', history.carton_id]);
        job = {
            cartonId: String(history.carton_id),
            historyId,
            printerId: history.printer_id,
            labelReference: history.label_content,
            labelPayload: history.label_payload
        };
        await connection.commit();
        transactionOpen = false;
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not prepare ARN label retry:', error);
        return res.status(500).json({ status: 'error', message: 'Could not retry the saved ARN label: ' + error.message });
    } finally {
        if (connection) connection.release();
    }

    const result = await transmitPrintJob(job);
    const state = await getStateForResponse(printerId);
    if (!result.success) {
        return res.status(502).json({ status: 'error', message: 'Retry failed. The saved ARN reference remains available to retry.', labelReference: job.labelReference, state });
    }
    return res.json({ status: 'success', message: job.labelReference, state });
});

// Reprint a previously sealed carton from Step 1. The exact saved SBPL
// payload and label reference are reused, so this never allocates a new ARN
// sequence number or changes the carton contents.
router.post('/api/cartons/:cartonId/reprint', async (req, res) => {
    const printerId = await getArnWorkflowPrinter(res);
    if (!printerId) return;
    const cartonId = String(req.params.cartonId || '').trim();
    if (!/^[1-9][0-9]*$/.test(cartonId)) {
        return res.status(400).json({ status: 'error', message: 'Choose a valid saved carton to reprint.' });
    }

    let connection;
    let transactionOpen = false;
    let labelReference = '';
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [rows] = await connection.execute(
            'SELECT c.id, c.printer_id, c.status, h.id AS print_history_id, h.label_content, h.label_payload, h.print_status ' +
            'FROM arn_cartons c ' +
            'LEFT JOIN arn_label_print_history h ON h.id = c.label_history_id ' +
            'WHERE c.id = ? FOR UPDATE',
            [cartonId]
        );
        if (!rows.length || rows[0].printer_id !== printerId) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(404).json({ status: 'error', message: 'That carton is not in this ARN station’s recent history.' });
        }

        const carton = rows[0];
        if (carton.status !== 'SEALED') {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'Only sealed cartons can be reprinted from the recent-carton list.' });
        }
        if (!carton.print_history_id || !carton.label_payload) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'This carton has no saved label payload, so it cannot be reprinted exactly.' });
        }
        if (carton.print_status === 'PENDING') {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({ status: 'error', message: 'A reprint is already being prepared for this carton. Check the printer before trying again.' });
        }

        const printerConfig = await getPrinterConfig(connection, printerId);
        if (!printerConfig) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(500).json({ status: 'error', message: 'The assigned ARN printer configuration is missing.' });
        }

        labelReference = String(carton.label_content || '');
        await connection.execute(
            'UPDATE arn_label_print_history SET retry_count = retry_count + 1, last_retry_at = CURRENT_TIMESTAMP, print_status = ?, last_error = NULL WHERE id = ?',
            ['PENDING', carton.print_history_id]
        );
        await connection.commit();
        transactionOpen = false;

        try {
            await printLabel_arn(carton.label_payload, printerConfig.IP, printerConfig.PORT);
            await connection.execute(
                'UPDATE arn_label_print_history SET print_status = ?, last_error = NULL WHERE id = ?',
                ['SENT', carton.print_history_id]
            );
            logger.log('Reprinted ARN carton ' + cartonId + ' label ' + labelReference + ' to ' + printerId + '.');
            return res.json({ status: 'success', labelReference, cartonId });
        } catch (printError) {
            await connection.execute(
                'UPDATE arn_label_print_history SET print_status = ?, last_error = ? WHERE id = ?',
                ['FAILED', String(printError.message || printError).slice(0, 4000), carton.print_history_id]
            );
            logger.error('Could not reprint ARN carton ' + cartonId + ' label ' + labelReference + ': ' + printError.message);
            return res.status(502).json({
                status: 'error',
                message: 'The saved label could not be sent. The carton remains sealed and the same label can be reprinted again.',
                labelReference,
                cartonId
            });
        }
    } catch (error) {
        if (connection && transactionOpen) await connection.rollback();
        logger.error('Could not reprint saved ARN carton:', error);
        return res.status(500).json({ status: 'error', message: 'Could not reprint the saved carton label.' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
