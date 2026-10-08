if (process.env.DB_CLIENT === 'sqlite') {
    // SQLite is an opt-in, disposable localhost test mode.
    module.exports = require('./sqliteTest');
} else {
    const mysql = require('mysql2/promise');

    // Replace with your actual database credentials
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'aMicf_bcps2025',
        database: process.env.DB_NAME || 'bcps_label',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    module.exports = pool;
}
