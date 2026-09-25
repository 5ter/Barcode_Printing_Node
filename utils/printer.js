const net = require('net');
const logger = require('./logger'); 

// Define a common timeout value in milliseconds
// The value is set to 1000ms (1 seconds) to align with the comment.
const PRINTER_TIMEOUT_MS = 1000; 

// ---------------------------------------------------------------------
// --- printLabel_one: Single Barcode/Text Label ---
// ---------------------------------------------------------------------

/**
 * Sends the SBPL command string to the SATO printer via raw TCP socket.
 * This function is now standalone and accepts configuration parameters.
 * @param {string} label_content The unique label data to print.
 * @param {string} PRINTER_IP The IP address of the printer.
 * @param {number} PRINTER_PORT The port for raw TCP printing (usually 9100).
 * @returns {Promise<void>} Resolves on success, rejects on connection/write error.
 */
function printLabel_one(label_content, PRINTER_IP, PRINTER_PORT){
    return new Promise((resolve, reject) => {
        // --- ASCII Control Character Definitions ---
        const STX = '\x02'; // Start of Text
        const ETX = '\x03'; // End of Text
        const ESC = '\x1b'; // Escape
        
        // --- Your complete SBPL Command String ---
        const SBPL_COMMAND_STRING =
            // --- Job 1: Printer Setup ---
            STX + ESC + 'A' + 
            ESC + 'A3V+00000H+0000' + // Set label origin
            ESC + 'CS7' + // Set density to 4
            ESC + '#F5' + // Set feed length to 5 dots
            ESC + 'A1V00240H0599' + // Set label size (V=240, H=599 dots)
            ESC + 'Z' + ETX + // Execute and End Job 1
            
            // --- Job 2: Barcode and Text Printing ---
            STX + ESC + 'A' + 
            ESC + 'PS' +  // Set print speed to Standard
            ESC + 'WKLabel' + // Name the format "Label"
            
            // 1. Draw Barcode (Code 128)
            ESC + '%0' + 
            ESC + 'H0100' + ESC + 'V00030' + // Position at H=100, V=30
            ESC + 'BG02120>H'+ label_content + // BG: Code 128 Barcode
            
            // 2. Draw Human-Readable Text
            ESC + '%0' + 
            ESC + 'H0052' + ESC + 'V00176' + // Position at H=52, V=176
            ESC + 'P02' +    // Select Font 02
            ESC + 'RDB@0,064,048,' + label_content + // RDB: Bitmap text
            
            ESC + 'Q1' + ESC + 'Z' + ETX; // Print Quantity 1, Execute and End Job 2


        const client = new net.Socket();
        
        // 🛠️ CRITICAL FIX: Set the timeout for the socket
        client.setTimeout(PRINTER_TIMEOUT_MS); 

        client.connect(PRINTER_PORT, PRINTER_IP, () => {
            logger.log(`Connected to printer at ${PRINTER_IP}:${PRINTER_PORT}`);
            
            const buffer = Buffer.from(SBPL_COMMAND_STRING, 'ascii');
            
            client.write(buffer, (err) => {
                client.end(); // Close connection after writing
                if (err) {
                    logger.error('❌ Error sending data:', err.message);
                    return reject(new Error('Failed to send print data to printer.'));
                } else {
                    logger.log('✅ SBPL command text sent successfully.');
                    return resolve();
                }
            });
        });

        // Handle the 'timeout' event (now functional)
        client.on('timeout', () => {
            client.destroy(); // Destroy the socket to ensure cleanup
            const errorMsg = `🚨 Print connection timed out (${PRINTER_TIMEOUT_MS}ms) to ${PRINTER_IP}`;
            logger.error(errorMsg);
            // Reject the promise to trigger the catch/rollback in the calling function
            reject(new Error(errorMsg)); 
        });

        client.on('error', (err) => {
            logger.error(`🚨 Connection error: ${err.message}. Ensure printer is online and on IP ${PRINTER_IP}`);
            // Check if connection is still active before rejecting
            if (client.connecting || client.destroyed) {
                return reject(new Error(`Printer connection failed: ${err.message}`));
            }
        });

        client.on('close', () => {
            logger.log('Printer connection closed.');
        });
    });
};

// ---------------------------------------------------------------------
// --- printLabel_two: Dual Barcode/Text Label ---
// ---------------------------------------------------------------------

/**
 * Sends the SBPL command string to the SATO printer via raw TCP socket, 
 * printing two distinct barcodes and two distinct text blocks on the same label.
 * * NOTE: The positions for the second barcode and text have been adjusted to 
 * print next to the first set (H coordinates shifted).
 * @param {string} label_content_1 The first unique label data to print.
 * @param {string} label_content_2 The second unique label data to print.
 * @param {string} PRINTER_IP The IP address of the printer.
 * @param {number} PRINTER_PORT The port for raw TCP printing (usually 9100).
 * @returns {Promise<void>} Resolves on success, rejects on connection/write error.
 */
function printLabel_two(label_content_1, label_content_2, PRINTER_IP, PRINTER_PORT){
    return new Promise((resolve, reject) => {
        // --- ASCII Control Character Definitions ---
        const STX = '\x02'; // Start of Text
        const ETX = '\x03'; // End of Text
        const ESC = '\x1b'; // Escape
        
        // --- Your complete SBPL Command String ---
        const SBPL_COMMAND_STRING =
            
            // --- Job 1: Printer Setup (86mm x 17mm @ 12 dots/mm) ---
            STX + ESC + 'A' + 
            ESC + 'A3V+00000H+0000' + // Set label origin
    //    ESC + 'CLD0' +
            ESC + 'CS2' +       // Set density to 6 (12 dots/mm)
            ESC + '#F8' +       // Set feed length to 5 dots
            // V=204 dots (17mm), H=1032 dots (86mm)
    //    ESC + 'L00204' +     // *** ADDED: Set Physical Label Length (17mm = 204 dots) ***
            ESC + 'A1V00204H01032' + 
            ESC + 'Z' + ETX +     // Execute and End Job 1
            
            // --- Job 2: Barcode and Text Printing ---
            STX + ESC + 'A' + 
            ESC + 'PS' +       // Set print speed to Standard
            ESC + 'WKLabel' +     // Name the format "Label"
            
            // 1. Draw 1st Barcode (Code 128) - Left side
            ESC + '%0' + 
         //   ESC + 'H0065' + ESC + 'V00032' +
             ESC + 'H0168' + ESC + 'V00032' + // Position 1: H=60, V=48
            ESC + 'BG02072>H'+ label_content_1 + // BG: Barcode (Type 01 assumed, Height 96 dots)

            // 2. Draw 2nd Barcode (Code 128) - Right side 
            ESC + '%0' + 
         //   ESC + 'H0581' + ESC + 'V00032' +
            ESC + 'H0684' + ESC + 'V00032' + // Position 2: H=660, V=48
            ESC + 'BG02072>H'+ label_content_2 + // BG: Barcode

            // 3. Draw 1st Human-Readable Text - Left side
            ESC + '%0' + 
           //  ESC + 'H0065' + ESC + 'V00120' +
            ESC + 'H0168' + ESC + 'V00120' + // Position 3: H=60, V=176 (Aligned under Barcode 1)
            ESC + 'P01' +     // Select Font 01
            ESC + 'RDB@0,040,040,' + label_content_1 + // RDB: Bitmap text (64x48 size)

            // 4. Draw 2nd Human-Readable Text - Right side 
            ESC + '%0' + 
            // FINE-TUNED: H=660 to align with Barcode 2
         //   ESC + 'H0581' + ESC + 'V00120' +
            ESC + 'H0684' + ESC + 'V00120' + // Position 4: H=660, V=176
            ESC + 'P01' +     // Select Font 01
            ESC + 'RDB@0,040,040,' + label_content_2 + // RDB: Bitmap text

            ESC + 'Q1' + ESC + 'Z' + ETX; // Print Quantity 1, Execute and End Job 2



        const client = new net.Socket();
        
        // 🛠️ CRITICAL FIX: Set the timeout for the socket
        client.setTimeout(PRINTER_TIMEOUT_MS); 

        client.connect(PRINTER_PORT, PRINTER_IP, () => {
            logger.log(`Connected to printer at ${PRINTER_IP}:${PRINTER_PORT}`);
            
            const buffer = Buffer.from(SBPL_COMMAND_STRING, 'ascii');
            
            client.write(buffer, (err) => {
                client.end(); // Close connection after writing
                if (err) {
                    logger.error('❌ Error sending data:', err.message);
                    return reject(new Error('Failed to send print data to printer.'));
                } else {
                    logger.log('✅ SBPL command text sent successfully.');
                    return resolve();
                }
            });
        });

        // Handle the 'timeout' event (now functional)
        client.on('timeout', () => {
            client.destroy(); // Destroy the socket to ensure cleanup
            const errorMsg = `🚨 Print connection timed out (${PRINTER_TIMEOUT_MS}ms) to ${PRINTER_IP}`;
            logger.error(errorMsg);
            // Reject the promise to trigger the catch/rollback in the calling function
            reject(new Error(errorMsg)); 
        });

        client.on('error', (err) => {
            logger.error(`🚨 Connection error: ${err.message}. Ensure printer is online and on IP ${PRINTER_IP}`);
            // Check if connection is still active before rejecting
            if (client.connecting || client.destroyed) {
                return reject(new Error(`Printer connection failed: ${err.message}`));
            }
        });

        client.on('close', () => {
            logger.log('Printer connection closed.');
        });
    });
};

//printLabel_one('1010598','10.0.12.57',9100);
// Export the function for use in other files
module.exports = {
    printLabel_one,
    printLabel_two
};