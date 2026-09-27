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

// --- Main Route: Handle Data Submission (with Transaction) ---
app.post('/submit-data', async (req, res) => {
    let connection;
    try {
        const { MO, ActID, printerUrl_id, labelMode, quantity: arnQuantity, PO: arnPurchaseOrder } = req.body;
        const selectedLabelMode = typeof labelMode === 'string'
            ? labelMode.trim().toUpperCase()
            : '';

        logger.log(`Received POST request with data: MO: ${MO}, ActID: ${ActID}, Printer: ${printerUrl_id}, Label mode: ${selectedLabelMode || '<missing>'}`);

        // Never guess the label type. A stale page that omits this value must
        // not accidentally enter the STANDARD path and create two records.
        if (selectedLabelMode !== 'STANDARD' && selectedLabelMode !== 'ARN') {
            return res.status(400).json({
                status: 'error',
                message: 'Label mode is missing or invalid. Reload the print page and select Standard or ARN.'
            });
        }

        const isArnLabel = selectedLabelMode === 'ARN';
        const quantity = Number(arnQuantity);
        const purchaseOrder = String(arnPurchaseOrder || '').trim();

        connection = await db.getConnection(); 
        await connection.beginTransaction(); 

        // 1. Fetch the base product details from the established table.
        const check_ref_query = 'SELECT Product_code, Manufacturing_ID, Customer_ID FROM product_code_ref WHERE Actmax_ID = ?';
        const [rows_ref] = await connection.execute(check_ref_query, [ActID]);

        if (rows_ref.length === 0) {
            logger.log('No product found for the given Actmax_ID.'); // Replaced
            await connection.rollback(); 
            return res.status(404).json({
                status: 'error',
                message: 'No product configuration found for the given Actmax_ID.'
            });
        }
        
        const { Product_code: productCode, Manufacturing_ID: manufacturingID, Customer_ID: customerID } = rows_ref[0];
        // The printing screen chooses which label layout to use. ARN quantity
        // and PO are supplied for this request and are not Excel fields.

        if (isArnLabel && (!Number.isInteger(quantity) || quantity <= 0 || !purchaseOrder)) {
            await connection.rollback();
            return res.status(400).json({
                status: 'error',
                message: 'ARN printing requires a positive whole-number quantity and a PO number.'
            });
        }

        // The browser may leave MO blank only for ARN products. Standard
        // products retain the former required-MO behaviour on the server.
        if (!isArnLabel && !String(MO || '').trim()) {
            await connection.rollback();
            return res.status(400).json({
                status: 'error',
                message: 'MO is required for a standard label.'
            });
        }

        logger.log('- Label Type: ' + (isArnLabel ? 'ARN' : 'STANDARD'));
        logger.log(`- Product_Code: ${productCode}`); // Replaced
        logger.log(`- Manufacturing_ID: ${manufacturingID}`); // Replaced
        logger.log(`- Customer_ID: ${customerID}`); // Replaced
        

        // --- NEW LOGIC: Determine which printer to use based on selectedPrinter ---
        const printerId = "PRINTER_"+ printerUrl_id;
        logger.log(`- printer_ID: ${printerId}`); // Replaced
        const printerConfig = config.getPrinterConfig(printerId);
        
        if (!printerConfig) {
            logger.error(`Printer configuration for ID ${printerId} not found.`); // Replaced with logger.error
            await connection.rollback();
            return res.status(500).json({
                status: 'error',
                message: `Printer configuration for ID ${printerId} is missing. Please check settings.`
            });
        }
        logger.log(`- Selected Printer: ${printerConfig.NAME} (${printerConfig.IP}:${printerConfig.PORT})`); // Replaced
        // -----------------------------------------------------------------

        // Call the imported function
        const yyww = getWWYY.getWWYY(); 
        const code_group = productCode + manufacturingID + yyww; 

        // ARN products reserve a number from arn_label_sequence. The primary
        // key is MO only: date, product code, and part number do not reset it.
        if (isArnLabel) {
            const arnMO = String(MO || '').trim() || arnLabelSettings.DEFAULT_MO;
            await connection.execute(
                'INSERT INTO arn_label_sequence (MO, last_item_no) VALUES (?, 0) ON DUPLICATE KEY UPDATE last_item_no = last_item_no + 1',
                [arnMO]
            );
            const [sequenceRows] = await connection.execute(
                'SELECT last_item_no FROM arn_label_sequence WHERE MO = ? FOR UPDATE',
                [arnMO]
            );
            const itemNo = Number(sequenceRows[0].last_item_no);
            if (!Number.isSafeInteger(itemNo) || itemNo < 0) {
                throw new Error('Invalid ARN sequence value for MO ' + arnMO);
            }

            const arnReference = yyww + '-' + itemNo.toString().padStart(6, '0');
            const [insertResult] = await connection.execute(
                'INSERT INTO products_unique (mo, Cust_part_no, Act_part_no, product_code_group, Unique_serial, Label_content, printer_ID) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [arnMO, customerID, ActID, code_group, itemNo, arnReference, printerId]
            );

            const arnPayload = generateArnLabel({
                arnPartNumber: customerID,
                quantity,
                manufacturerPartNumber: ActID,
                purchaseOrder,
                dateCode: yyww,
                itemNo,
                manufacturerName: arnLabelSettings.MANUFACTURER_NAME,
                madeInText: arnLabelSettings.MADE_IN_TEXT
            });

            await printLabel_arn(arnPayload, printerConfig.IP, printerConfig.PORT);
            await connection.commit();
            logger.log('Single ARN label printed and transaction committed successfully.');

            return res.status(200).json({
                status: 'success',
                message: arnReference,
                insertedId: [insertResult.insertId],
                newSerial: [itemNo.toString().padStart(6, '0')],
                customerID
            });
        }

        // 2. Standard-label serial logic remains exactly as it was.
        const serial_query = 'SELECT MAX(CAST(Unique_serial AS UNSIGNED)) AS max_serial FROM products_unique WHERE product_code_group = ? FOR UPDATE'; 
        const [rows] = await connection.execute(serial_query, [code_group]);
        
        const lastSerial = rows[0].max_serial || 0;
        const newSerial = (lastSerial + 1).toString().padStart(5, '0'); // Serial 1
        const newSerial_2 = (lastSerial + 2).toString().padStart(5, '0'); // Serial 2

        const label_Con = productCode + manufacturingID + yyww + newSerial; // Label content 1
        const label_Con_2 = productCode + manufacturingID + yyww + newSerial_2; // Label content 2

        logger.log(`- New Serial 1: ${newSerial}`); // Replaced
        logger.log(`- New Serial 2: ${newSerial_2}`); // Replaced
        logger.log(`- Label Content 1: ${label_Con}`); // Replaced
        logger.log(`- Label Content 2: ${label_Con_2}`); // Replaced
        logger.log(`- Product code group: ${code_group}`); // Replaced

        // 3. Insert the new data for the FIRST label
        const [insertResult] = await connection.execute(
            'INSERT INTO products_unique (mo, Cust_part_no, Act_part_no, product_code_group, Unique_serial, Label_content, printer_ID) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [MO, customerID, ActID, code_group, newSerial, label_Con, printerId]
        );

        // 3. Insert the new data for the SECOND label (HIDE HERE if only need to print 1 label)
        const [insertResult_2] = await connection.execute(
            'INSERT INTO products_unique (mo, Cust_part_no, Act_part_no, product_code_group, Unique_serial, Label_content, printer_ID) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [MO, customerID, ActID, code_group, newSerial_2, label_Con_2, printerId] // <-- Using newSerial_2 and label_Con_2
        );

        logger.log('Data for both labels inserted successfully into transaction.'); // Replaced
        
        // 4. Print the label (now passing the dynamically selected IP and Port)
        // You are calling printLabel_one AND printLabel_two, this may print 3 labels total. 
        // Assuming you intended to print ONLY the combined label:

//----> await printLabel_one(label_Con, printerConfig.IP, printerConfig.PORT); // <-- Comment out if you only want printLabel_two
      await printLabel_two(label_Con, label_Con_2, printerConfig.IP, printerConfig.PORT); // <-- AWAIT PRINTING, passing selected config


        // 5. Commit the transaction (DB write is finalized only after successful print)
        await connection.commit();
        logger.log('Database transaction committed successfully.'); // Replaced

        // 6. Send a success response
        res.status(200).json({
            status: 'success',
            message: ` ${label_Con}, ${label_Con_2}`,
            insertedId: [insertResult.insertId, insertResult_2.insertId],
            newSerial: [newSerial, newSerial_2],
            customerID: customerID
        });

    } catch (error) {
        // Rollback the transaction on ANY error (DB or Printing)
        if (connection) {
            await connection.rollback();
            logger.log('Database transaction rolled back.'); // Replaced
        }
        
        logger.error('Error processing data:', error); // Replaced with logger.error
        res.status(500).json({
            status: 'error',
            message: 'An error occurred while processing your request: ' + error.message
        });
    } finally {
        if (connection) {
            connection.release(); // Always release the connection
            logger.log('Database connection released.'); // Replaced
        }
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
