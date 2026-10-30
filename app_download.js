// server.js

const express = require('express');
const { Parser } = require('json2csv');
const path = require('path');
const app = express();
const db = require('./db/root'); // Assuming this exports your database pool
const port = process.env.PORT || 3006;
const mainAppPort = Number(process.env.MAIN_APP_PORT) || 3003;
const logger = require('./utils/logger'); 
const authRouter = require('./routes/auth');
const { requirePageAccess } = require('./utils/auth');
// Serve static files (like your download_interface.html)
// Note: Changed to serve from the root directory for simplicity, 
// assuming 'download_interface.html' is in a 'views' folder or similar.
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/image', express.static(path.join(__dirname, 'image')));
app.get('/image/actmax_logo.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'actmax_logo.png'));
});
app.use(express.json());
app.use(authRouter);
app.get('/app-shell.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').sendFile(path.join(__dirname, 'views', 'appShell.js'));
});

function mainHubUrl(req) {
    const hub = new URL(req.protocol + '://' + req.get('host'));
    hub.port = String(mainAppPort);
    hub.pathname = '/';
    hub.search = '';
    hub.hash = '';
    return hub;
}

function downloadLoginRedirect(req) {
    const returnTarget = req.protocol + '://' + req.get('host') + (req.originalUrl || '/');
    const hub = mainHubUrl(req);
    hub.searchParams.set('login', 'required');
    hub.searchParams.set('returnTo', returnTarget);
    return hub.toString();
}

const downloadAccess = requirePageAccess('download', {
    loginRedirect: downloadLoginRedirect,
    homeUrl: req => mainHubUrl(req).toString()
});

// Root route to serve the interactive HTML file
app.get('/', downloadAccess, (req, res) => {
    // Ensure the path to your HTML file is correct
    res.sendFile(path.join(__dirname, 'views', 'download_interface.html'));
});

// 2. API endpoint to handle the download request
app.get('/api/download-table', downloadAccess, async (req, res) => {
    const { start, end } = req.query; // Dates will be in 'YYYY-MM-DD' format from the HTML input
    let connection; // Declare connection outside try block for scope

    if (!start || !end) {
        return res.status(400).send("Please provide both start and end dates.");
    }

    try {
        // 1. Get a connection from the pool
        connection = await db.getConnection(); 
        
        // Define the SQL query with parameterized values (safer against SQL Injection)
        // Adjust 'your_table' and 'created_at' to your actual table and timestamp column.
        const sql = `
            SELECT * FROM products_unique 
            WHERE date >= ? AND date <= ?
        `;
        
        // Adjust end date to include the entire day for the database query (e.g., '2025-09-29 23:59:59')
        // We use a simple string concatenation here, but your DB driver might handle date objects better.
        const endDateInclusive = `${end} 23:59:59`;
        
        // --- Step 1: Query Data from SQL ---
        const [rows] = await connection.execute(sql, [start, endDateInclusive]);

        const filteredData = rows; // The result of the query
        
        if (filteredData.length === 0) {
            return res.status(404).send("No data found for the selected time range.");
        }

        // --- Step 2: Convert to CSV ---
        const json2csvParser = new Parser();
        const csv = json2csvParser.parse(filteredData);

        // --- Step 3: Send Downloadable Response ---
        const filename = `Report_${start}_to_${end}.csv`;
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        res.send(csv);

    } catch (err) {
        console.error("Download Error:", err);
        // Do NOT expose detailed error message to the client
        return res.status(500).send("A server error occurred during data extraction.");
    } finally {
        // Release the connection back to the pool in the 'finally' block
        if (connection) {
            connection.release();
        }
    }
});

app.listen(port, () => {
    logger.log(`Server running at http://localhost:${port}`);
});
