const mysql = require('mysql2/promise');

// Replace with your actual database credentials
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'aMicf_bcps2025',
    database: 'bcps_label',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool; 