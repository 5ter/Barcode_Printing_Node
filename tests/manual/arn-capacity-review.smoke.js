'use strict';

// Run with: node tests/manual/arn-capacity-review.smoke.js
// This uses a disposable SQLite database and dry-run printing only.
const assert = require('assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Remove a database artifact produced by pre-memory versions of this smoke test.
const legacyDatabaseFile = path.join(__dirname, 'arn-capacity-review.smoke.sqlite');
try { fs.rmSync(legacyDatabaseFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }

process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';
process.env.DRY_RUN_ARN_PRINTING = 'true';

const db = require('../../db/root');
const arnRouter = require('../../routes/arnTraceability');

async function request(baseUrl, pathName, body) {
    const response = await fetch(baseUrl + pathName, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const payload = await response.json();
    assert.equal(response.ok, true, payload.message);
    return payload;
}

async function main() {
    const connection = await db.getConnection();
    await connection.execute(
        'INSERT INTO arn_label_data (MO, arn_part_no, quantity, manufacturer_part_no, purchase_order) VALUES (?, ?, ?, ?, ?)',
        ['MO-CAPACITY', 'ARN-CAPACITY', 2, 'MPN-CAPACITY', 'PO-CAPACITY']
    );

    const app = express();
    app.use(express.json());
    app.use('/arn', arnRouter);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const { port } = server.address();
    const baseUrl = 'http://127.0.0.1:' + port;

    try {
        await request(baseUrl, '/arn/api/lock', { mo: 'MO-CAPACITY', manufacturerPartNo: 'MPN-CAPACITY' });
        await request(baseUrl, '/arn/api/scan', { content: 'PRODUCT-001' });
        const capacityResult = await request(baseUrl, '/arn/api/scan', { content: 'PRODUCT-001' });

        assert.equal(capacityResult.cartonReadyToSeal, true);
        assert.equal(capacityResult.state.carton.status, 'OPEN');
        assert.equal(capacityResult.state.carton.scanned_count, 2);
        assert.equal(capacityResult.state.printHistory, null);

        const removalResult = await request(baseUrl, '/arn/api/scan/remove', { scanId: capacityResult.scanId });
        assert.equal(removalResult.state.carton.status, 'OPEN');
        assert.equal(removalResult.state.carton.scanned_count, 1);
        assert.equal(removalResult.state.scans.length, 1);

        const [historyRows] = await connection.execute('SELECT COUNT(*) AS count FROM arn_label_print_history');
        assert.equal(historyRows[0].count, 0, 'capacity review must not allocate or print an ARN label');

        const completed = await request(baseUrl, '/arn/api/carton/complete');
        assert.equal(completed.state.carton.status, 'SEALED');
        assert.equal(completed.state.printHistory.quantity, 1);
        console.log('PASS: capacity review keeps the carton editable and prints only after Complete & Seal.');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
