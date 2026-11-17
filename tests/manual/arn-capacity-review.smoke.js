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

async function postExpectingError(baseUrl, pathName, body, expectedStatus) {
    const response = await fetch(baseUrl + pathName, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const payload = await response.json();
    assert.equal(response.status, expectedStatus, payload.message);
    return payload;
}

async function getJson(baseUrl, pathName) {
    const response = await fetch(baseUrl + pathName);
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

        const activeCartonId = String(removalResult.state.carton.id);
        const recentWhileActive = await getJson(baseUrl, '/arn/api/recent-cartons');
        assert.equal(recentWhileActive.cartons.find(carton => carton.id === activeCartonId).canAbandon, false);
        await postExpectingError(baseUrl, '/arn/api/cartons/' + activeCartonId + '/abandon', {}, 409);

        const [historyRows] = await connection.execute('SELECT COUNT(*) AS count FROM arn_label_print_history');
        assert.equal(historyRows[0].count, 0, 'capacity review must not allocate or print an ARN label');

        const completed = await request(baseUrl, '/arn/api/carton/complete');
        assert.equal(completed.state.carton.status, 'SEALED');
        assert.equal(completed.state.printHistory.quantity, 1);

        const [emptyInsert] = await connection.execute(
            'INSERT INTO arn_cartons (printer_id, mo, manufacturer_part_no, arn_part_no, purchase_order, box_capacity, scanned_count, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
            ['PRINTER_D', 'MO-EMPTY', 'MPN-EMPTY', 'ARN-EMPTY', 'PO-EMPTY', 2, 'OPEN']
        );
        const [scannedInsert] = await connection.execute(
            'INSERT INTO arn_cartons (printer_id, mo, manufacturer_part_no, arn_part_no, purchase_order, box_capacity, scanned_count, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
            ['PRINTER_D', 'MO-SCANNED', 'MPN-SCANNED', 'ARN-SCANNED', 'PO-SCANNED', 2, 'OPEN']
        );
        await connection.execute(
            'INSERT INTO arn_carton_scans (carton_id, scanned_content, removed_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
            [String(scannedInsert.insertId), 'PRODUCT-WAS-SCANNED']
        );

        const emptyCartonId = String(emptyInsert.insertId);
        const scannedCartonId = String(scannedInsert.insertId);
        const recentBeforeAbandon = await getJson(baseUrl, '/arn/api/recent-cartons');
        assert.equal(recentBeforeAbandon.cartons.find(carton => carton.id === emptyCartonId).canAbandon, true);
        assert.equal(recentBeforeAbandon.cartons.find(carton => carton.id === scannedCartonId).canAbandon, false);

        const abandoned = await request(baseUrl, '/arn/api/cartons/' + emptyCartonId + '/abandon', {});
        assert.equal(abandoned.cartonStatus, 'ABANDONED');
        const [abandonedRows] = await connection.execute('SELECT status FROM arn_cartons WHERE id = ?', [emptyCartonId]);
        assert.equal(abandonedRows[0].status, 'ABANDONED');
        await postExpectingError(baseUrl, '/arn/api/cartons/' + scannedCartonId + '/abandon', {}, 409);
        console.log('PASS: capacity review, safe abandonment of empty cartons, and protection of active/scanned cartons.');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
