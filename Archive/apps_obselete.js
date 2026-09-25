const express = require('express');
const db = require('../db/root'); // Assuming this exports a connection pool
const moment = require('moment-timezone');
const app = express();
const net = require('net');

// Middleware to parse JSON requests
app.use(express.json());


// Barcode routes (your separate file)
const barcodeRoutes = require('../routes/barcode');
app.use(barcodeRoutes);

// Main route to handle data submission
app.post('/submit-data', async (req, res) => {
  let connection;
  try {
    const { MO, CustID, ActID } = req.body;
    console.log(`Received POST request with data: MO: ${MO}, CustID: ${CustID}, ActID: ${ActID}`);

    connection = await db.getConnection(); // Get a connection from the pool

    // Check product code
    const check_ref_query = 'SELECT * FROM product_code_ref WHERE Actmax_ID = ?';
    const [rows_ref] = await connection.execute(check_ref_query, [ActID]);

    let productCode = null;
    let manufacturingID = null;

    if (rows_ref.length > 0) {
      productCode = rows_ref[0].Product_code;
      manufacturingID = rows_ref[0].Manufacturing_ID;
      console.log(`- Product_Code: ${productCode}`);
      console.log(`- Manufacturing_ID: ${manufacturingID}`);

      // 1. All necessary data found. Proceed with generating and inserting.
      const yyww = getYearAndWorkWeek();
      
      // Fetch the latest serial from the database
      const [rows] = await connection.execute('SELECT MAX(Unique_serial) AS max_serial FROM products_unique WHERE Act_part_no = ?', [ActID]);
      const lastSerial = rows[0].max_serial || 0;
      const newSerial = (lastSerial + 1).toString().padStart(5, '0'); // Pad with zeros

      // Combine the parts into the final label
      const label_Con = productCode + manufacturingID + yyww + newSerial;
      console.log(`- Label Content: ${label_Con}`);

      // 2. Insert the new data into the database
      const [insertResult] = await connection.execute(
        'INSERT INTO products_unique (mo, Cust_part_no, Act_part_no, Unique_serial, Label_content) VALUES (?, ?, ?, ?, ?)',
        [MO, CustID, ActID, newSerial, label_Con]
      )
      console.log('Data inserted successfully.');

      printLabel(label_Con);//print label

      // 3. Send a success response
      res.status(200).json({
        status: 'success',
        message: 'Data received and processed successfully! - ' + label_Con,
        insertedId: insertResult.insertId,
        newSerial: newSerial
      });

    } else {
      // Handle the case where no product was found
      console.log('No product found for the given Actmax_ID.');
      res.status(404).json({
        status: 'error',
        message: 'No product found for the given Act_ID.'
      });
    }

  } catch (error) {
    console.error('Error processing data:', error);
    res.status(500).json({
      status: 'error',
      message: 'An error occurred while processing your request.'
    });
  } finally {
    if (connection) {
      connection.release(); // Always release the connection
      console.log('Database connection released.');
    }
  }
});

// The getYearAndWorkWeek function can stay outside the route handler
function getYearAndWorkWeek() {
  const now = moment();
  const year = now.format('YY');
  const week = now.format('WW');
  const formattedDate = year + week;

  console.log(`Current Date: ${now.format('YYYY-MM-DD')}`);
  console.log(`Formatted Year and Work Week (YYWW): ${formattedDate}`);
  
  return formattedDate;
};

// Get the label print based on the generated unique Serial
function printLabel(label_content){

    const PRINTER_IP = '192.168.0.10'; // Replace with your SATO Printer's IP
    const PRINTER_PORT = 9100;          // Standard raw printing port

    // --- ASCII Control Character Definitions ---
    // These are the correct hex escape sequences for Node.js strings
    const STX = '\x02'; // Start of Text
    const ETX = '\x03'; // End of Text
    const ESC = '\x1b'; // Escape
    const CR = '\x0d';  // Carriage Return
    const LF = '\x0a';  // Line Feed

    const label_con = label_content;

    // --- Your complete SBPL Command String ---
    // Replace the bracketed placeholders with the actual control characters
    const SBPL_COMMAND_STRING =
        // --- Job 1: Printer Setup ---
        STX + ESC + 'A' + 
        ESC + 'A3V+00000H+0000' + // Set label origin
        ESC + 'CS4' +             // Set density to 4
        ESC + '#F5' +             // Set feed length to 5 dots
        ESC + 'A1V00240H0599' +   // Set label size (V=240, H=599 dots)
        ESC + 'Z' + ETX +         // Execute and End Job 1
        
        // --- Job 2: Barcode and Text Printing ---
        STX + ESC + 'A' + 
        ESC + 'PS' +              // Set print speed to Standard
        ESC + 'WKLabel' +         // Name the format "Label"
        
        // 1. Draw Barcode (Code 128)
        ESC + '%0' + 
        ESC + 'H0040' + ESC + 'V00040' + // Position at H=40, V=40
        ESC + 'BG02120>H'+ label_con +   // BG: Code 128 Barcode, 31 dots wide, 20 dots high, data: AbCd22ff123
        
        // 2. Draw Human-Readable Text
        ESC + '%0' + 
        ESC + 'H040' + ESC + 'V00176' + // Position at H=160, V=176
        ESC + 'P02' +                    // Select Font 02 (higer mean greater font space)
        ESC + 'RDB@0,064,048,' + label_con + // RDB: Bitmap text, W=64, H=48, text: AbCd22ff123
        
        ESC + 'Q1' + ESC + 'Z' + ETX; // Print Quantity 1, Execute and End Job 2

    // --- Printing Function ---


    // Create a client socket and send the command
    const client = new net.Socket();

    client.connect(PRINTER_PORT, PRINTER_IP, () => {
        console.log(`Connected to printer at ${PRINTER_IP}:${PRINTER_PORT}`);

        // Sending as a Buffer ensures the raw control characters are preserved correctly
        const buffer = Buffer.from(SBPL_COMMAND_STRING, 'ascii');
      //  console.log(buffer);
        
        client.write(buffer, (err) => {
            if (err) {
                console.error('❌ Error sending data:', err.message);
            } else {
                console.log('✅ SBPL command text sent successfully.');
            }

            // Close the connection
            client.end();
        });
    });

    client.on('error', (err) => {
        console.error(`🚨 Connection error: ${err.message}. Ensure printer is online and on IP ${PRINTER_IP}`);
    });

    client.on('close', () => {
        console.log('Connection closed.');
    });

};

// Route to fetch and display data
app.get('/fetch-data', async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const [rows] = await connection.execute('SELECT * FROM product_code_ref');
    
    // Process and log the data on the server side
    console.log('Data extracted:');
    rows.forEach(row => {
      const customerID = parseInt(row.Customer_ID);
      const customerID_serial = customerID + 1;
      console.log(`- customerID: ${customerID}`);
      console.log(`- DateTime: ${row.update_date}`);
      console.log(`- customerSerial: ${customerID_serial}`);
      console.log(`- User ID: ${row.ID}, Name: ${row.Product_name}, Email: ${row.Product_code}`);
    });
    
    // Send the data as a JSON response to the client
    res.status(200).json({
      status: 'success',
      data: rows
    });

  } catch (error) {
    console.error('Error fetching data:', error);
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

// Start the server
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});