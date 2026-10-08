const express = require('express');
const db = require('./db/root'); // Assumed to export a connection pool with promise support
const app = express();
const path = require('path'); // Required for resolving paths

// --- Configuration Imports ---
const config = require('./config/printerSetting'); 
const PORT = config.PORT; 

// --- NEW: Import the custom logger utility ---
const logger = require('./utils/logger'); 

// --- Middleware ---
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/image', express.static(path.join(__dirname, 'image')));
app.use(express.json());

// --- Routes ---
const barcodeRoutes = require('./routes/barcode');
app.use(barcodeRoutes);

// --- Utility Functions Imports ---
const getWWYY = require('./utils/dateTime'); 
const { printLabel_two, printLabel_arn } = require('./utils/printer');
const { generateArnLabel } = require('./utils/arn_label');
const arnLabelSettings = require('./config/arnLabelSetting');

// --- Main Route: Handle Standard or ARN label submissions transactionally ---
app.post('/submit-data', async (req, res) => {
    let connection;
    let transactionOpen = false;
    try {
        const { MO, ActID, ManufacturerPartNo, printerUrl_id, labelMode } = req.body;
        const selectedLabelMode = typeof labelMode === 'string' ? labelMode.trim().toUpperCase() : '';

        logger.log(
            'Received POST request: MO: ' + (MO || '') +
            ', ActID: ' + (ActID || '') +
            ', ManufacturerPartNo: ' + (ManufacturerPartNo || '') +
            ', Printer: ' + (printerUrl_id || '') +
            ', Label mode: ' + (selectedLabelMode || '<missing>')
        );

        // The active tab explicitly selects the print flow; never infer it from
        // which fields happened to be submitted.
        if (selectedLabelMode !== 'STANDARD' && selectedLabelMode !== 'ARN') {
            return res.status(400).json({
                status: 'error',
                message: 'Label mode is missing or invalid. Reload the print page and select Standard or ARN.'
            });
        }

        const isArnLabel = selectedLabelMode === 'ARN';
        const mo = String(MO || '').trim();
        const manufacturerPartNumber = String(ManufacturerPartNo || '').trim();

        if (isArnLabel && (!mo || !manufacturerPartNumber)) {
            return res.status(400).json({
                status: 'error',
                message: 'ARN printing requires the MO reference and Manufacturer Part No. from the Excel row.'
            });
        }
        if (!isArnLabel && !mo) {
            return res.status(400).json({
                status: 'error',
                message: 'MO is required for a standard label.'
            });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;

        let arnData;
        let productCode;
        let manufacturingID;
        let customerID;

        if (isArnLabel) {
            // The ARN table is keyed by Manufacturer Part No. The operator's
            // MO is a reference recorded with this print, not a lookup key.
            // This branch deliberately does not read product_code_ref or write
            // to products_unique.
            const [arnRows] = await connection.execute(
                'SELECT arn_part_no, quantity, manufacturer_part_no, purchase_order FROM arn_label_data WHERE manufacturer_part_no = ?',
                [manufacturerPartNumber]
            );
            if (arnRows.length === 0) {
                await connection.rollback();
                transactionOpen = false;
                return res.status(404).json({
                    status: 'error',
                    message: 'No ARN Excel row matches that Manufacturer Part No. Check the part number and upload the current workbook.'
                });
            }
            arnData = arnRows[0];
        } else {
            // Existing Standard lookup and its print/serial flow remain separate.
            const checkRefQuery =
                'SELECT Product_code, Manufacturing_ID, Customer_ID FROM product_code_ref WHERE Actmax_ID = ?';
            const [rowsRef] = await connection.execute(checkRefQuery, [ActID]);
            if (rowsRef.length === 0) {
                logger.log('No product found for the given Actmax_ID.');
                await connection.rollback();
                transactionOpen = false;
                return res.status(404).json({
                    status: 'error',
                    message: 'No product configuration found for the given Actmax_ID.'
                });
            }
            ({
                Product_code: productCode,
                Manufacturing_ID: manufacturingID,
                Customer_ID: customerID
            } = rowsRef[0]);
        }

        logger.log('- Label Type: ' + selectedLabelMode);
        if (isArnLabel) {
            logger.log('- ARN Part No.: ' + arnData.arn_part_no);
            logger.log('- Manufacturer Part No.: ' + arnData.manufacturer_part_no);
            logger.log('- MO reference: ' + mo);
            logger.log('- Quantity printed on label: ' + arnData.quantity);
            logger.log('- Purchase Order: ' + arnData.purchase_order);
        } else {
            logger.log('- Product_Code: ' + productCode);
            logger.log('- Manufacturing_ID: ' + manufacturingID);
            logger.log('- Customer_ID: ' + customerID);
        }

        // Use the printer selected in the interface (A-D) for either mode.
        const printerId = 'PRINTER_' + printerUrl_id;
        logger.log('- printer_ID: ' + printerId);
        const printerConfig = config.getPrinterConfig(printerId);
        if (!printerConfig) {
            logger.error('Printer configuration for ID ' + printerId + ' not found.');
            await connection.rollback();
            transactionOpen = false;
            return res.status(500).json({
                status: 'error',
                message: 'Printer configuration for ID ' + printerId + ' is missing. Please check settings.'
            });
        }
        logger.log('- Selected Printer: ' + printerConfig.NAME + ' (' + printerConfig.IP + ':' + printerConfig.PORT + ')');

        const yyww = getWWYY.getWWYY();

        if (isArnLabel) {
            // Sequence is scoped to Manufacturer Part No. A new part starts
            // at 1; later labels for that part increment after a successful print.
            await connection.execute(
                'INSERT INTO arn_label_part_sequence (manufacturer_part_no, last_item_no) VALUES (?, 1) ON DUPLICATE KEY UPDATE last_item_no = last_item_no + 1',
                [manufacturerPartNumber]
            );
            const [sequenceRows] = await connection.execute(
                'SELECT last_item_no FROM arn_label_part_sequence WHERE manufacturer_part_no = ? FOR UPDATE',
                [manufacturerPartNumber]
            );
            const itemNo = Number(sequenceRows[0].last_item_no);
            if (!Number.isSafeInteger(itemNo) || itemNo < 1) {
                throw new Error('Invalid ARN sequence value for Manufacturer Part No. ' + manufacturerPartNumber);
            }

            const arnReference = yyww + '-' + itemNo.toString().padStart(6, '0');
            const arnPayload = generateArnLabel({
                arnPartNumber: arnData.arn_part_no,
                quantity: arnData.quantity,
                manufacturerPartNumber: arnData.manufacturer_part_no,
                purchaseOrder: arnData.purchase_order,
                dateCode: yyww,
                itemNo,
                manufacturerName: arnLabelSettings.MANUFACTURER_NAME,
                madeInText: arnLabelSettings.MADE_IN_TEXT
            });

            const [historyInsert] = await connection.execute(
                'INSERT INTO arn_label_print_history (mo, arn_part_no, quantity, manufacturer_part_no, purchase_order, date_code, item_no, label_content, printer_id, label_payload, print_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    mo,
                    arnData.arn_part_no,
                    arnData.quantity,
                    arnData.manufacturer_part_no,
                    arnData.purchase_order,
                    yyww,
                    itemNo,
                    arnReference,
                    printerId,
                    arnPayload,
                    'PENDING'
                ]
            );

            // Save the reserved reference and exact SBPL before sending. A
            // retry reuses this job and does not allocate another item number.
            await connection.commit();
            transactionOpen = false;

            const printHistoryId = String(historyInsert.insertId);
            try {
                // Exactly one ARN label is sent. Quantity is label data, not copies.
                await printLabel_arn(arnPayload, printerConfig.IP, printerConfig.PORT);
                await connection.execute(
                    'UPDATE arn_label_print_history SET print_status = ?, last_error = NULL WHERE id = ?',
                    ['SENT', printHistoryId]
                );
                logger.log('ARN label payload sent for reference ' + arnReference + '.');
            } catch (printError) {
                logger.error('ARN print attempt failed for reference ' + arnReference + ': ' + printError.message);
                try {
                    await connection.execute(
                        'UPDATE arn_label_print_history SET print_status = ?, last_error = ? WHERE id = ?',
                        ['FAILED', String(printError.message || printError).slice(0, 4000), printHistoryId]
                    );
                } catch (statusError) {
                    logger.error('Could not update ARN print status for history ID ' + printHistoryId + ': ' + statusError.message);
                }
                return res.status(502).json({
                    status: 'error',
                    message: 'The printer send did not complete successfully. After correcting the printer, retry the saved label with the same reference.',
                    printHistoryId,
                    labelReference: arnReference,
                    arnPartNo: arnData.arn_part_no,
                    retryAvailable: true
                });
            }

            return res.status(200).json({
                status: 'success',
                message: arnReference,
                newSerial: itemNo.toString().padStart(6, '0'),
                mo,
                arnPartNo: arnData.arn_part_no,
                quantity: arnData.quantity,
                manufacturerPartNo: arnData.manufacturer_part_no,
                purchaseOrder: arnData.purchase_order,
                printHistoryId,
                retryAvailable: true
            });
        }

        // Existing Standard serial calculation, two inserts, and combined
        // printer call are intentionally retained.
        const code_group = productCode + manufacturingID + yyww;
        const serial_query =
            'SELECT MAX(CAST(Unique_serial AS UNSIGNED)) AS max_serial FROM products_unique WHERE product_code_group = ? FOR UPDATE';
        const [rows] = await connection.execute(serial_query, [code_group]);

        const lastSerial = rows[0].max_serial || 0;
        const newSerial = (lastSerial + 1).toString().padStart(5, '0');
        const newSerial_2 = (lastSerial + 2).toString().padStart(5, '0');
        const label_Con = productCode + manufacturingID + yyww + newSerial;
        const label_Con_2 = productCode + manufacturingID + yyww + newSerial_2;

        logger.log('- New Serial 1: ' + newSerial);
        logger.log('- New Serial 2: ' + newSerial_2);
        logger.log('- Label Content 1: ' + label_Con);
        logger.log('- Label Content 2: ' + label_Con_2);
        logger.log('- Product code group: ' + code_group);

        const [insertResult] = await connection.execute(
            'INSERT INTO products_unique (mo, Cust_part_no, Act_part_no, product_code_group, Unique_serial, Label_content, printer_ID) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [MO, customerID, ActID, code_group, newSerial, label_Con, printerId]
        );
        const [insertResult_2] = await connection.execute(
            'INSERT INTO products_unique (mo, Cust_part_no, Act_part_no, product_code_group, Unique_serial, Label_content, printer_ID) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [MO, customerID, ActID, code_group, newSerial_2, label_Con_2, printerId]
        );

        logger.log('Data for both Standard labels inserted successfully into transaction.');
        await printLabel_two(label_Con, label_Con_2, printerConfig.IP, printerConfig.PORT);
        await connection.commit();
        transactionOpen = false;
        logger.log('Database transaction committed successfully.');

        return res.status(200).json({
            status: 'success',
            message: label_Con + ', ' + label_Con_2,
            insertedId: [insertResult.insertId, insertResult_2.insertId],
            newSerial: [newSerial, newSerial_2],
            customerID
        });
    } catch (error) {
        if (connection && transactionOpen) {
            await connection.rollback();
            transactionOpen = false;
            logger.log('Database transaction rolled back.');
        }
        logger.error('Error processing data:', error);
        return res.status(500).json({
            status: 'error',
            message: 'An error occurred while processing your request: ' + error.message
        });
    } finally {
        if (connection) {
            connection.release();
            logger.log('Database connection released.');
        }
    }
});

// Re-send the exact saved ARN payload without touching its part sequence.
app.post('/retry-arn-print', async (req, res) => {
    let connection;
    let transactionOpen = false;
    let retryHistoryId = '';
    let retryReference = '';
    try {
        retryHistoryId = String(req.body && req.body.printHistoryId || '').trim();
        if (!/^[1-9][0-9]*$/.test(retryHistoryId)) {
            return res.status(400).json({
                status: 'error',
                message: 'A valid ARN print history ID is required.'
            });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;

        const [historyRows] = await connection.execute(
            'SELECT id, label_content, label_payload, printer_id, arn_part_no FROM arn_label_print_history WHERE id = ? FOR UPDATE',
            [retryHistoryId]
        );
        if (historyRows.length === 0) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(404).json({
                status: 'error',
                message: 'The ARN print record was not found.'
            });
        }

        const job = historyRows[0];
        retryReference = String(job.label_content);
        if (!job.label_payload) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(409).json({
                status: 'error',
                message: 'This older ARN print has no saved printer payload and cannot be retried exactly.'
            });
        }

        const printerConfig = config.getPrinterConfig(job.printer_id);
        if (!printerConfig) {
            await connection.rollback();
            transactionOpen = false;
            return res.status(500).json({
                status: 'error',
                message: 'The original printer configuration is missing. The label reference has not changed.',
                printHistoryId: retryHistoryId,
                labelReference: retryReference,
                retryAvailable: true
            });
        }

        await connection.execute(
            'UPDATE arn_label_print_history SET retry_count = retry_count + 1, last_retry_at = CURRENT_TIMESTAMP, print_status = ?, last_error = NULL WHERE id = ?',
            ['PENDING', retryHistoryId]
        );

        try {
            await printLabel_arn(job.label_payload, printerConfig.IP, printerConfig.PORT);
        } catch (printError) {
            await connection.execute(
                'UPDATE arn_label_print_history SET print_status = ?, last_error = ? WHERE id = ?',
                ['FAILED', String(printError.message || printError).slice(0, 4000), retryHistoryId]
            );
            await connection.commit();
            transactionOpen = false;
            logger.error('ARN retry failed for reference ' + retryReference + ': ' + printError.message);
            return res.status(502).json({
                status: 'error',
                message: 'Retry failed. The same ARN reference is still available to retry.',
                printHistoryId: retryHistoryId,
                labelReference: retryReference,
                arnPartNo: job.arn_part_no,
                retryAvailable: true
            });
        }

        await connection.execute(
            'UPDATE arn_label_print_history SET print_status = ?, last_error = NULL WHERE id = ?',
            ['SENT', retryHistoryId]
        );
        await connection.commit();
        transactionOpen = false;
        logger.log('ARN reference ' + retryReference + ' resent without incrementing its part sequence.');

        return res.status(200).json({
            status: 'success',
            message: retryReference,
            printHistoryId: retryHistoryId,
            arnPartNo: job.arn_part_no,
            retryAvailable: true
        });
    } catch (error) {
        if (connection && transactionOpen) {
            await connection.rollback();
            transactionOpen = false;
        }
        logger.error('Error retrying ARN print:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Could not retry the saved ARN label: ' + error.message,
            printHistoryId: retryHistoryId || undefined,
            labelReference: retryReference || undefined,
            retryAvailable: Boolean(retryHistoryId && retryReference)
        });
    } finally {
        if (connection) connection.release();
    }
});

// --- Route to fetch and display data ---
app.get('/fetch-data', async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        const [rows] = await connection.execute('SELECT * FROM product_code_ref');
        
        // Processing/logging on the server side
        logger.log('Data extracted:'); // Replaced
        rows.forEach(row => {
            logger.log(`- ID: ${row.ID}, Product: ${row.Product_name}, Code: ${row.Product_code}`); // Replaced
        });
        
        res.status(200).json({
            status: 'success',
            data: rows
        });

    } catch (error) {
        logger.error('Error fetching data:', error); // Replaced with logger.error
        res.status(500).json({
            status: 'error',
            message: 'An error occurred while fetching data.'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// --- Start the server ---
app.listen(PORT, () => {
    logger.log(`Server is running on port ${PORT}`); // Replaced
});
