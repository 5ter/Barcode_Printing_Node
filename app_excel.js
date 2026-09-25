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

// 2. Define the database columns and table name
const DB_TABLE = 'product_code_ref'; 
const DB_COLUMNS = [
'product_name', 
'product_code',
'manufacturing_id',
'customer_id',
'actmax_id' // This MUST be a UNIQUE KEY in your MySQL table
];
const UNIQUE_KEY_COLUMN = 'actmax_id';
const PLACEHOLDERS = DB_COLUMNS.map(() => '?').join(', '); 

// --- Utility Functions ---

// Generates the human-readable list of required headers for the HTML
function getRequiredHeadersMessage() {
return DB_COLUMNS.map(h => 
h.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
).join(', ');
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
            <small class="text-danger">Note: Headers are case and space insensitive, but listed here with proper names.</small>
          </div>
        </div>
      </div>
      <!-- Bootstrap JS bundle (optional, but needed for proper component handling) -->
   
    </body>
    </html>
`);
});

// 2. Handle the file upload and database UPSERT (Insert or Update)
app.post('/upload', upload.single('excelFile'), async (req, res) => {
    // Check 1: No file uploaded (early return, no cleanup needed)
    if (!req.file) {
        return res.status(400).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Upload Error</title>
                <!-- Using CDN for reliability in error page -->
                <link href="css/bootstrap.min.css" rel="stylesheet"> 
            </head>
            <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
                <div class="card shadow-lg p-5 text-center" style="max-width: 500px;">
                    <h1 class="card-title text-danger mb-3">Upload Failed</h1>
                    <p class="text-danger mb-4">No file was uploaded. Please select an Excel file.</p>
                    <a href="/" class="btn btn-warning mt-3">Try again</a>
                </div>
            </body>
            </html>
        `);
    }

    const filePath = req.file.path;
    
    // Check 2: Empty file (0 bytes) - CRITICAL CHECK ADDED
    if (req.file.size === 0) {
        // Immediate cleanup is required for this early return
        fs.unlink(filePath, (err) => {
            if (err) logger.error('Error deleting 0-byte file:', err);
            logger.log(`Cleaned up 0-byte temporary file: ${filePath}`);
        });
        
        return res.status(400).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Upload Error</title>
               <link href="css/bootstrap.min.css" rel="stylesheet"> 
            </head>
            <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
                <div class="card shadow-lg p-5 text-center" style="max-width: 500px;">
                    <h1 class="card-title text-danger mb-3">Upload Failed</h1>
                    <p class="text-danger mb-4">The uploaded file is **empty (0 bytes)**. Please ensure the file contains data.</p>
                    <a href="/" class="btn btn-warning mt-3">Try again</a>
                </div>
            </body>
            </html>
        `);
    }


    let rowsToInsert = [];
    let headers = [];

    try {
        // --- A. Read and Parse the Excel file using exceljs ---
        const workbook = new Excel.Workbook();
        await workbook.xlsx.readFile(filePath);
        const worksheet = workbook.getWorksheet(1);

        // 1. Get Headers and normalize them (e.g., "Product Name" -> "product_name")
        const headerRow = worksheet.getRow(1);
        if (headerRow.values) {
            headers = headerRow.values
                .slice(1)
                .map(h => h ? h.toString().toLowerCase().trim().replace(/\s/g, '_') : null)
                .filter(h => h);
        } else {
            throw new Error("Could not read headers from the Excel file.");
        }

        // 2. Validate that required headers are present
        const missingHeaders = DB_COLUMNS.filter(col => !headers.includes(col));
        if (missingHeaders.length > 0) {
            throw new Error(`Missing required Excel columns`);
        }

        // 3. Iterate over data rows
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) { // Skip the header row
                let rowObject = {};
                const values = row.values.slice(1); 

                headers.forEach((header, index) => {
                    let cellValue = values[index];
                    // Handle potential Cell object values from exceljs (e.g., if a cell contains a formula)
                    if (cellValue && typeof cellValue === 'object' && cellValue.result !== undefined) {
                        cellValue = cellValue.result; // Use calculated value
                    } else if (cellValue && typeof cellValue === 'object' && cellValue.text !== undefined) {
                        cellValue = cellValue.text; // Use text value
                    }
                    rowObject[header] = cellValue;
                });

                // Only push the row if the unique key column has a value
                if (rowObject[UNIQUE_KEY_COLUMN]) {
                    rowsToInsert.push(rowObject);
                }
            }
        });

        // Check 3: File contains headers but no data rows (Updated to styled response)
        if (rowsToInsert.length === 0) {
            // File cleanup is handled in the final block.
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>No Data Found</title>
                    <link href="css/bootstrap.min.css" rel="stylesheet"> 
                <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
                    <div class="card shadow-lg p-5 text-center" style="max-width: 500px;">
                        <h1 class="card-title text-warning mb-3">No Data Found ⚠️</h1>
                        <p class="text-warning mb-4">The Excel file contains headers but no valid data rows to process (The unique key column may be empty).</p>
                        <a href="/" class="btn btn-warning mt-3">Try again</a>
                    </div>
                </body>
                </html>
            `);
        }

        // --- B. Perform UPSERT (INSERT OR UPDATE) using the DB Pool ---
        let insertedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0; 

        const connection = await db.getConnection(); 
        await connection.beginTransaction();

        try {
            // Construct the UPDATE part of the query (update all columns except the unique key)
            const updateClauses = DB_COLUMNS
                .filter(col => col !== UNIQUE_KEY_COLUMN) 
                .map(col => `${col} = VALUES(${col})`)
                .join(', ');

            // Final UPSERT query
            const upsertQuery = `
                INSERT INTO ${DB_TABLE} (${DB_COLUMNS.join(', ')}) 
                VALUES (${PLACEHOLDERS})
                ON DUPLICATE KEY UPDATE 
                ${updateClauses};
            `;

            for (const row of rowsToInsert) {
                // Construct the values array in the correct order
                const values = DB_COLUMNS.map(col => row[col] || null);

                // Execute the UPSERT query
                const [result] = await connection.execute(upsertQuery, values);

                // Check affectedRows: 1 = INSERT, 2 = UPDATE, 0 = NO CHANGE
                if (result.affectedRows === 1) {
                    insertedCount++;
                } else if (result.affectedRows === 2) {
                    updatedCount++;
                } else if (result.affectedRows === 0) {
                    skippedCount++; // Explicitly count rows where MySQL reported no change
                }
            }

            await connection.commit();

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Import Result</title>
                   <link href="css/bootstrap.min.css" rel="stylesheet"> 
                </head>
                <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
                    <div class="card shadow-lg p-5 text-center" style="max-width: 500px;">
                        <h1 class="card-title text-success mb-3">Import Successful! 🎉</h1>
                        <p class="lead">Total rows processed: <strong>${rowsToInsert.length}</strong></p>
                        <ul class="list-group list-group-flush text-start mb-4">
                            <li class="list-group-item">Inserted: <span class="badge bg-primary float-end">${insertedCount}</span></li>
                            <li class="list-group-item">Updated: <span class="badge bg-warning float-end">${updatedCount}</span></li>
                            <li class="list-group-item">Skipped (no change): <span class="badge bg-secondary float-end">${skippedCount}</span></li>
                        </ul>
                        <a href="/" class="btn btn-primary mt-3">Upload another file</a>
                    </div>
                </body>
                </html>
            `);

        } catch (dbError) {
            await connection.rollback();
            throw dbError; // Throw up to the main catch block
        } finally {
            connection.release(); // Return connection to the pool
        }

    } catch (error) {
        logger.error('Processing/Database Error:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Import Failed</title>
              <link href="css/bootstrap.min.css" rel="stylesheet"> 
            <body class="bg-light d-flex align-items-center justify-content-center vh-100 p-3">
                <div class="card shadow-lg p-5 text-center" style="max-width: 500px;">
                    <h1 class="card-title text-danger mb-3">Import Failed </h1>
                    <p class="text-danger mb-4">An error occurred: ${error.message}</p>
                    <a href="/" class="btn btn-warning mt-3">Try again</a>
                </div>
            </body>
            </html>
        `);
    } finally {
        // C. Clean up the temporary file (only runs if filePath was defined)
        if (filePath) {
            fs.unlink(filePath, (err) => {
                if (err) logger.error('Error deleting file:', err);
                logger.log(`Cleaned up temporary file: ${filePath}`);
            });
        }
    }
});

app.listen(port, () => {
logger.log(`Server running at http://localhost:${port}`);
});
