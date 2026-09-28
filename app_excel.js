const express = require('express');
const multer = require('multer');
const Excel = require('exceljs');
const fs = require('fs');
const path = require('path'); // Path module required for static serving

// Must require db/root BEFORE using DB methods
const db = require('./db/root'); 

const app = express();
const port = process.env.PORT || 3005;

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
    'purchase_order',
    'mo_no'
];
const ARN_DB_COLUMNS = [
    'arn_part_no',
    'quantity',
    'manufacturer_part_no',
    'purchase_order',
    'mo'
];

// --- Utility Functions ---

// Generates the human-readable list of required headers for the HTML
function getRequiredHeadersMessage() {
    return `<p class="mb-1"><strong>Standard:</strong> Product Name, Product Code, Manufacturing ID, Customer ID, Actmax ID</p>
            <p class="mb-1"><strong>ARN:</strong> ARN PartNo, Quantity, Manufacturer PartNo, Purchase Order, MO No.</p>`;
}

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


// --- Routes ---

// Serve static files (like CSS) from the 'css' directory
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/image', express.static(path.join(__dirname, 'image')));
// 1. Serve the simple HTML upload form (NOW DYNAMICALLY RENDERED WITH BOOTSTRAP)
app.get('/', (req, res) => {
  // Generate the required headers list dynamically
  const requiredHeaders = getRequiredHeadersMessage();

  // Send the HTML content using a template literal
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Excel Uploader</title>
      <!-- Bootstrap CSS -->
      <link href="css/bootstrap.min.css" rel="stylesheet"> 
      <style>
        body {
          font-family: 'Inter', sans-serif;
          background-color: #f8f9fa; /* Light background */
        }
        .upload-card {
          max-width: 600px;
          width: 100%;
        }
        #labelLogo { 
            /* Set a fixed size for the logo next to the title */
            width: 40px; /* Updated size */
            height: 40px; /* Updated size */
            border-radius: 0px; 
            object-fit: contain;
        }
      </style>
    </head>
    <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
      <div class="card upload-card shadow-lg border-0 rounded-3">
        <div class="card-body p-5">

            <div class="d-flex align-items-center justify-content-center mb-4"> 
        <!--<img id="labelLogo" src="image/actmax_logo.webp" alt="Label Logo" class="me-3">-->     
            <img id="labelLogo" src="image/actmax_logo.webp" alt="Label Logo" class="me-2">
            <h1 class="h1 text-dark text-start mb-0">Upload Excel to DB </h1>
        </div>
             <p class="text-muted text-center mb-4">
            Select an Excel file (\`.xlsx\` or \`.xls\`) to import.
          </p>

          <form action="/upload" method="post" enctype="multipart/form-data" class="needs-validation" novalidate>
            <div class="mb-3">
              <label for="excelFile" class="form-label">Choose File (Max 1MB)</label>
              <input 
                type="file" 
                name="excelFile" 
                id="excelFile" 
                accept=".xlsx, .xls" 
                required
                class="form-control"
              >
            </div>
            <button 
              type="submit"
              class="btn btn-primary w-100 py-2 shadow-sm"
            >
              Upload and Import Data
            </button>
          </form>

          <div class="alert alert-danger mt-4" role="alert">
            <h6 class="alert-heading mb-2">Required Excel Headers (in the first row):</h6>
            <small class="text-danger">Upload either a Standard workbook or an ARN workbook. Header matching ignores capitalization and punctuation.</small>
            <div class="mt-2 text-dark">${requiredHeaders}</div>
            <p class="small text-muted mt-2 mb-0">ARN MO must be unique. Re-uploading identical data is skipped; if any ARN row value changes, assign that row a new MO.</p>
          </div>
        </div>
      </div>
      <!-- Bootstrap JS bundle (optional, but needed for proper component handling) -->
   
    </body>
    </html>
`);
});

// 2. Handle workbook uploads. Standard rows keep the legacy UPSERT; ARN rows
// are immutable by MO and are inserted only into the ARN-specific table.
app.post('/upload', upload.single('excelFile'), async (req, res) => {
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
        const seenMo = new Set();
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

            const mo = String(rowObject.mo_no).trim();
            const moKey = mo.toUpperCase();
            if (seenMo.has(moKey)) {
                const error = new Error('ARN worksheet contains MO ' + mo + ' more than once. Each ARN row must have its own unique MO.');
                error.statusCode = 400;
                throw error;
            }
            seenMo.add(moKey);
            rowsToImport.push({
                data: {
                    arn_partno: String(rowObject.arn_partno).trim(),
                    quantity,
                    manufacturer_partno: String(rowObject.manufacturer_partno).trim(),
                    purchase_order: String(rowObject.purchase_order).trim(),
                    mo_no: mo
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
        connection = await db.getConnection();
        await connection.beginTransaction();

        try {
            if (importMode === 'ARN') {
                for (const importedRow of rowsToImport) {
                    const row = importedRow.data;
                    const [existingRows] = await connection.execute(
                        'SELECT arn_part_no, quantity, manufacturer_part_no, purchase_order FROM arn_label_data WHERE mo = ? FOR UPDATE',
                        [row.mo_no]
                    );

                    if (existingRows.length) {
                        const existing = existingRows[0];
                        const unchanged =
                            String(existing.arn_part_no) === row.arn_partno &&
                            Number(existing.quantity) === row.quantity &&
                            String(existing.manufacturer_part_no) === row.manufacturer_partno &&
                            String(existing.purchase_order) === row.purchase_order;

                        if (!unchanged) {
                            const error = new Error(
                                'MO ' + row.mo_no + ' already exists with different label data. The existing row was not changed; assign a new MO in Excel for the changed data.'
                            );
                            error.statusCode = 409;
                            throw error;
                        }
                        skippedCount++;
                        continue;
                    }

                    await connection.execute(
                        'INSERT INTO arn_label_data (' + ARN_DB_COLUMNS.join(', ') + ') VALUES (?, ?, ?, ?, ?)',
                        [row.arn_partno, row.quantity, row.manufacturer_partno, row.purchase_order, row.mo_no]
                    );
                    insertedCount++;
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

            await connection.commit();
        } catch (databaseError) {
            await connection.rollback();
            if (importMode === 'ARN' && databaseError.code === 'ER_DUP_ENTRY') {
                databaseError.statusCode = 409;
                databaseError.message =
                    'An ARN MO in this workbook already exists. Existing MO rows are never overwritten; assign a new MO for changed data.';
            }
            throw databaseError;
        } finally {
            connection.release();
            connection = null;
        }

        const updatedLine = importMode === 'STANDARD'
            ? '<li class="list-group-item">Updated: <span class="badge bg-warning float-end">' + updatedCount + '</span></li>'
            : '<li class="list-group-item">ARN rows are immutable: a changed record must use a new MO.</li>';
        return res.send(`
            <!DOCTYPE html>
            <html><head><title>Import Result</title><link href="css/bootstrap.min.css" rel="stylesheet"></head>
            <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
                <div class="card shadow-lg p-5 text-center" style="max-width: 600px;">
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
            <html><head><title>Import Failed</title><link href="css/bootstrap.min.css" rel="stylesheet"></head>
            <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
                <div class="card shadow-lg p-5 text-center" style="max-width: 600px;">
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

app.listen(port, () => {
logger.log(`Server running at http://localhost:${port}`);
});
