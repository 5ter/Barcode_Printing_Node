const express = require('express');
const multer = require('multer');
const Excel = require('exceljs');
const fs = require('fs');
const path = require('path'); // Path module required for static serving

// Must require db/root BEFORE using DB methods
const db = require('./db/root'); 

const app = express();
const port = process.env.PORT || 3005;
const mainAppPort = Number(process.env.MAIN_APP_PORT) || 3003;
const uploaderPagePath = path.join(__dirname, 'excel uploader page', 'code.html');
const authRouter = require('./routes/auth');
const { requirePageAccess, getRequestRole } = require('./utils/auth');

// --- Configuration ---
// --- NEW: Import the custom logger utility ---
const logger = require('./utils/logger'); 


// 1. Multer setup to handle file uploads
const upload = multer({ dest: 'uploads/' });

// Standard imports retain their existing table and UPSERT behavior.
const DB_TABLE = 'product_code_ref';
const DB_COLUMNS = [
    'product_name',
    'product_code',
    'manufacturing_id',
    'customer_id',
    'actmax_id'
];
const UNIQUE_KEY_COLUMN = 'actmax_id';
const PLACEHOLDERS = DB_COLUMNS.map(() => '?').join(', ');
const ARN_COLUMNS = [
    'arn_partno',
    'quantity',
    'manufacturer_partno',
    'purchase_order'
];
const ARN_DB_COLUMNS = [
    'arn_part_no',
    'quantity',
    'manufacturer_part_no',
    'purchase_order'
];
const EXCEL_INGESTION_LOG_LIMIT = 12;

// --- Utility Functions ---

function normalizeHeader(value) {
    return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function getCellValue(cell) {
    let value = cell.value;
    if (value && typeof value === 'object') {
        if (value.result !== undefined) value = value.result;
        else if (Array.isArray(value.richText)) value = value.richText.map(part => part.text).join('');
        else if (value.text !== undefined) value = value.text;
    }
    if (value === null || value === undefined) return '';
    // Use Excel's displayed text for numeric identifiers (for example, values
    // formatted with leading zeroes); otherwise preserve the underlying value.
    return typeof value === 'number' && cell.text ? cell.text.trim() : String(value).trim();
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function uploadFileName(file) {
    // Keep the audit log useful without retaining a client-supplied path or
    // control characters in a database field that is later displayed in HTML.
    return path.basename(String(file && file.originalname || 'workbook.xlsx'))
        .replace(/[\x00-\x1F\x7F]/g, '')
        .slice(0, 255) || 'workbook.xlsx';
}

function ingestionLogUnavailable(error) {
    return error && (error.code === 'ER_NO_SUCH_TABLE' || /no such table: excel_ingestion_audit_log/i.test(error.message));
}


// --- Routes ---

// Serve static files (like CSS) from the 'css' directory
app.use(express.json());
app.use(authRouter);
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/image', express.static(path.join(__dirname, 'image')));
app.get('/image/actmax_logo.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'actmax_logo.png'));
});
app.get('/app-shell.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').sendFile(path.join(__dirname, 'views', 'appShell.js'));
});
// Serve the supplied redesign and replace its prototype-only interactions with
// the real workbook upload client. The existing /upload parser stays unchanged.
function mainHubUrl(req) {
    const hub = new URL(req.protocol + '://' + req.get('host'));
    hub.port = String(mainAppPort);
    hub.pathname = '/';
    hub.search = '';
    hub.hash = '';
    return hub;
}

function uploaderLoginRedirect(req) {
    const returnTarget = req.protocol + '://' + req.get('host') + (req.originalUrl || '/');
    const hub = mainHubUrl(req);
    hub.searchParams.set('login', 'required');
    hub.searchParams.set('returnTo', returnTarget);
    return hub.toString();
}

const uploaderAccess = requirePageAccess('excel', {
    loginRedirect: uploaderLoginRedirect,
    homeUrl: req => mainHubUrl(req).toString()
});

app.get('/', uploaderAccess, (req, res) => {
    fs.readFile(uploaderPagePath, 'utf8', (error, sourceHtml) => {
        if (error) {
            logger.error('Unable to load Excel uploader page:', error);
            return res.status(500).type('text').send(
                'The Excel uploader page is unavailable. Ensure "excel uploader page/code.html" is included in the deployment.'
            );
        }

        const pageMainPort = mainAppPort;
        const html = sourceHtml
            // The mock script displayed fake commits and sample operator data.
            .replace(/<script>\s*\/\/ UI Micro-interactions[\s\S]*?<\/script>/i, '')
            // Do not serve the supplied design's sample audit rows even briefly.
            // The browser replaces this loading row with committed import data.
            .replace(
                /<tbody id="ingestionLogRows"[^>]*>[\s\S]*?<\/tbody>/i,
                '<tbody id="ingestionLogRows" class="font-body-md text-body-md divide-y divide-surface-container">' +
                '<tr><td class="py-space-md px-space-md text-on-surface-variant text-center" colspan="6">Loading committed workbook imports…</td></tr></tbody>'
            )
            .replace(/<header\b[^>]*>[\s\S]*?<\/header>/i, '')
            .replace(/\bpt-16\b/, '')
            .replace(/<body\b/i, '<body data-excel-theme data-main-app-port="' + pageMainPort + '" data-excel-app-port="' + Number(port) + '"')
            .replace(/(<body\b[^>]*>)/i, '$1<div id="app-shell"></div>')
            .replace('</head>', '<meta name="theme-color" content="#0d0912"><link rel="stylesheet" href="/css/app-shell.css"><link rel="stylesheet" href="/css/excel-theme.css"><link rel="stylesheet" href="/css/theme-modes.css"><script src="/app-shell.js" defer></script></head>')
            .replace('</body>', '<script src="/excel-uploader.js" defer></script></body>');

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.type('html').send(html);
    });
});

app.get('/excel-uploader.js', uploaderAccess, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('application/javascript').sendFile(path.join(__dirname, 'views', 'excelUploader.js'));
});

app.get('/templates/standard', uploaderAccess, (req, res) => {
    res.download(path.join(__dirname, 'Product_Code-Template.xlsx'));
});

app.get('/templates/arn', uploaderAccess, (req, res) => {
    res.download(path.join(__dirname, 'ARN_Template.xlsx'));
});

// This is intentionally a committed-import audit log, not a preview of the
// currently staged file. Every row is written in the same transaction as the
// imported workbook data, so a log entry never exists for a rolled-back import.
app.get('/api/ingestion-log', uploaderAccess, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        const [rows] = await connection.execute(
            'SELECT id, source_file_name AS sourceFileName, file_size_bytes AS fileSizeBytes, ' +
            'schema_type AS schemaType, rows_processed AS rowsProcessed, ' +
            'inserted_rows AS insertedRows, updated_rows AS updatedRows, skipped_rows AS skippedRows, ' +
            'status, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt ' +
            'FROM excel_ingestion_audit_log ORDER BY uploaded_at DESC, id DESC LIMIT ?',
            [String(EXCEL_INGESTION_LOG_LIMIT)]
        );
        return res.json({ status: 'success', rows });
    } catch (error) {
        logger.error('Excel ingestion audit log read failed:', error);
        const message = ingestionLogUnavailable(error)
            ? 'The Excel ingestion audit table is not available. Apply migration 20261029_add_excel_ingestion_audit_log.sql first.'
            : 'Could not load the Excel ingestion audit log.';
        return res.status(500).json({ status: 'error', message });
    } finally {
        if (connection) connection.release();
    }
});

// 2. Handle workbook uploads. Standard rows keep the legacy UPSERT; ARN rows
// are keyed and updated by Manufacturer PartNo in the ARN-specific table.
app.post('/upload', uploaderAccess, upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('<p>No file was uploaded. Please select an Excel file.</p><p><a href="/">Try again</a></p>');
    }

    const filePath = req.file.path;
    let connection;
    let importMode = '';

    try {
        if (req.file.size === 0) {
            const error = new Error('The uploaded file is empty (0 bytes).');
            error.statusCode = 400;
            throw error;
        }

        const workbook = new Excel.Workbook();
        try {
            await workbook.xlsx.readFile(filePath);
        } catch (parseError) {
            parseError.statusCode = 400;
            throw parseError;
        }
        const worksheet = workbook.getWorksheet(1);
        if (!worksheet) {
            const error = new Error('The workbook does not contain a first worksheet.');
            error.statusCode = 400;
            throw error;
        }

        const headerRow = worksheet.getRow(1);
        const headerColumns = [];
        const headerNames = new Set();
        for (let column = 1; column <= headerRow.cellCount; column++) {
            const name = normalizeHeader(getCellValue(headerRow.getCell(column)));
            headerColumns.push({ column, name });
            if (name && headerNames.has(name)) {
                const error = new Error('The worksheet contains a duplicate header: ' + name);
                error.statusCode = 400;
                throw error;
            }
            if (name) headerNames.add(name);
        }

        const hasStandardHeaders = DB_COLUMNS.every(column => headerNames.has(column));
        const hasArnHeaders = ARN_COLUMNS.every(column => headerNames.has(column));
        if (hasStandardHeaders === hasArnHeaders) {
            const error = new Error(
                'The first row must contain exactly one supported template: either the Standard headers or the ARN headers shown on the upload page.'
            );
            error.statusCode = 400;
            throw error;
        }
        importMode = hasArnHeaders ? 'ARN' : 'STANDARD';
        const requiredColumns = importMode === 'ARN' ? ARN_COLUMNS : DB_COLUMNS;
        const missingHeaders = requiredColumns.filter(column => !headerNames.has(column));
        if (missingHeaders.length) {
            const error = new Error('Missing required columns: ' + missingHeaders.join(', '));
            error.statusCode = 400;
            throw error;
        }

        const rowsToImport = [];
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            const rowObject = {};
            for (const header of headerColumns) {
                if (header.name) rowObject[header.name] = getCellValue(row.getCell(header.column));
            }

            const hasAnyValue = requiredColumns.some(column => String(rowObject[column] || '').trim() !== '');
            if (!hasAnyValue) return;

            if (importMode === 'STANDARD') {
                // Match the old importer: rows without an Actmax ID are ignored.
                if (rowObject[UNIQUE_KEY_COLUMN]) {
                    rowsToImport.push({ data: rowObject, rowNumber });
                }
                return;
            }

            const missingValues = ARN_COLUMNS.filter(column => String(rowObject[column] || '').trim() === '');
            if (missingValues.length) {
                const error = new Error(
                    'ARN worksheet row ' + rowNumber + ' is incomplete. Required values missing: ' + missingValues.join(', ')
                );
                error.statusCode = 400;
                throw error;
            }

            const quantityText = String(rowObject.quantity).trim();
            const quantity = Number(quantityText);
            if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 4294967295) {
                const error = new Error('ARN worksheet row ' + rowNumber + ' must have a Quantity from 1 to 4,294,967,295.');
                error.statusCode = 400;
                throw error;
            }

            for (const textColumn of ['arn_partno', 'manufacturer_partno', 'purchase_order']) {
                if (!/^[\x20-\x7E]+$/.test(String(rowObject[textColumn]).trim())) {
                    const error = new Error(
                        'ARN worksheet row ' + rowNumber + ' has non-printable or non-ASCII characters in ' + textColumn + '.'
                    );
                    error.statusCode = 400;
                    throw error;
                }
            }

            const manufacturerPartNumber = String(rowObject.manufacturer_partno).trim();
            rowsToImport.push({
                data: {
                    arn_partno: String(rowObject.arn_partno).trim(),
                    quantity,
                    manufacturer_partno: manufacturerPartNumber,
                    purchase_order: String(rowObject.purchase_order).trim()
                },
                rowNumber
            });
        });

        if (rowsToImport.length === 0) {
            const error = new Error('The worksheet contains headers but no valid data rows.');
            error.statusCode = 400;
            throw error;
        }

        let insertedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        const fileName = uploadFileName(req.file);
        const uploadedBy = req.authRole || getRequestRole(req) || 'UNKNOWN';
        connection = await db.getConnection();
        await connection.beginTransaction();

        try {
            if (importMode === 'ARN') {
                const arnUpsertQuery =
                    'INSERT INTO arn_label_data (' + ARN_DB_COLUMNS.join(', ') + ') VALUES (?, ?, ?, ?)' +
                    ' ON DUPLICATE KEY UPDATE arn_part_no = VALUES(arn_part_no), ' +
                    'quantity = VALUES(quantity), purchase_order = VALUES(purchase_order)';
                for (const importedRow of rowsToImport) {
                    const row = importedRow.data;
                    const values = [row.arn_partno, row.quantity, row.manufacturer_partno, row.purchase_order];
                    const [result] = await connection.execute(arnUpsertQuery, values);
                    if (result.affectedRows === 1) insertedCount++;
                    else if (result.affectedRows === 2) updatedCount++;
                    else if (result.affectedRows === 0) skippedCount++;
                }
            } else {
                const updateClauses = DB_COLUMNS
                    .filter(column => column !== UNIQUE_KEY_COLUMN)
                    .map(column => column + ' = VALUES(' + column + ')')
                    .join(', ');
                const upsertQuery =
                    'INSERT INTO ' + DB_TABLE + ' (' + DB_COLUMNS.join(', ') + ') VALUES (' + PLACEHOLDERS + ')' +
                    ' ON DUPLICATE KEY UPDATE ' + updateClauses;

                for (const importedRow of rowsToImport) {
                    const row = importedRow.data;
                    const values = DB_COLUMNS.map(column => row[column] || null);
                    const [result] = await connection.execute(upsertQuery, values);
                    if (result.affectedRows === 1) insertedCount++;
                    else if (result.affectedRows === 2) updatedCount++;
                    else if (result.affectedRows === 0) skippedCount++;
                }
            }

            await connection.execute(
                'INSERT INTO excel_ingestion_audit_log ' +
                '(source_file_name, file_size_bytes, schema_type, rows_processed, inserted_rows, updated_rows, skipped_rows, status, uploaded_by) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    fileName,
                    Number(req.file.size) || 0,
                    importMode,
                    rowsToImport.length,
                    insertedCount,
                    updatedCount,
                    skippedCount,
                    'SUCCESS',
                    uploadedBy
                ]
            );

            await connection.commit();
        } catch (databaseError) {
            await connection.rollback();
            if (importMode === 'ARN' && databaseError.code === 'ER_DUP_ENTRY') {
                databaseError.statusCode = 409;
                databaseError.message =
                    'The ARN table has a conflicting unique key. Verify that the Manufacturer Part No. re-key migration has been applied and existing duplicate part numbers have been reconciled.';
            }
            if (ingestionLogUnavailable(databaseError)) {
                databaseError.statusCode = 503;
                databaseError.message =
                    'The Excel ingestion audit table is not available. Apply migration 20261029_add_excel_ingestion_audit_log.sql before importing workbooks.';
            }
            throw databaseError;
        } finally {
            connection.release();
            connection = null;
        }

        const updatedLine = '<li class="list-group-item">Updated: <span class="badge bg-warning float-end">' + updatedCount + '</span></li>';
        return res.send(`
            <!DOCTYPE html>
            <html><head><meta name="theme-color" content="#0d0912"><title>Import Result</title><link href="css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="/css/app-shell.css"><link rel="stylesheet" href="/css/excel-theme.css"><link rel="stylesheet" href="/css/theme-modes.css"><script src="/app-shell.js" defer></script></head>
            <body class="bg-light min-vh-100 p-3" data-excel-theme data-main-app-port="${mainAppPort}" data-excel-app-port="${Number(port)}">
                <div id="app-shell"></div>
                <div class="card shadow-lg p-5 text-center" style="max-width: 600px; margin:40px auto;">
                    <h1 class="card-title text-success mb-3">Import Successful</h1>
                    <p class="lead">${importMode} rows processed: <strong>${rowsToImport.length}</strong></p>
                    <ul class="list-group list-group-flush text-start mb-4">
                        <li class="list-group-item">Inserted: <span class="badge bg-primary float-end">${insertedCount}</span></li>
                        ${updatedLine}
                        <li class="list-group-item">Skipped (unchanged): <span class="badge bg-secondary float-end">${skippedCount}</span></li>
                    </ul>
                    <a href="/" class="btn btn-primary mt-3">Upload another file</a>
                </div>
            </body></html>
        `);
    } catch (error) {
        logger.error('Processing/Database Error:', error);
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).send(`
            <!DOCTYPE html>
            <html><head><meta name="theme-color" content="#0d0912"><title>Import Failed</title><link href="css/bootstrap.min.css" rel="stylesheet"><link rel="stylesheet" href="/css/app-shell.css"><link rel="stylesheet" href="/css/excel-theme.css"><link rel="stylesheet" href="/css/theme-modes.css"><script src="/app-shell.js" defer></script></head>
            <body class="bg-light min-vh-100 p-3" data-excel-theme data-main-app-port="${mainAppPort}" data-excel-app-port="${Number(port)}">
                <div id="app-shell"></div>
                <div class="card shadow-lg p-5 text-center" style="max-width: 600px; margin:40px auto;">
                    <h1 class="card-title text-danger mb-3">Import Failed</h1>
                    <p class="text-danger mb-4">${escapeHtml(error.message)}</p>
                    <a href="/" class="btn btn-warning mt-3">Try again</a>
                </div>
            </body></html>
        `);
    } finally {
        if (connection) connection.release();
        fs.unlink(filePath, error => {
            if (error) logger.error('Error deleting uploaded file:', error);
        });
    }
});

if (require.main === module) {
    app.listen(port, () => {
        logger.log(`Server running at http://localhost:${port}`);
    });
}

module.exports = app;
