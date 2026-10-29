'use strict';

// Run with: node tests/manual/printer-configuration.smoke.js
// Uses disposable SQLite storage to verify that printer details and routing
// are saved atomically, including the ARN active-work guard.
const assert = require('assert/strict');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.AUTH_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';

const db = require('../../db/root');
const printerSetupRouter = require('../../routes/printerSetup');
const { COOKIE_NAME, createSessionToken } = require('../../utils/auth');

function adminHeaders() {
    return {
        Cookie: COOKIE_NAME + '=' + encodeURIComponent(createSessionToken('ADMIN')),
        'Content-Type': 'application/json'
    };
}

async function request(baseUrl, pathName, options = {}) {
    const response = await fetch(baseUrl + pathName, {
        ...options,
        headers: { ...adminHeaders(), ...(options.headers || {}) }
    });
    return { response, payload: await response.json() };
}

async function main() {
    const app = express();
    app.use(express.json());
    app.use(printerSetupRouter);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const connection = await db.getConnection();
    const payload = {
        name: 'Configuration Test Printer',
        model: 'ZT411',
        location: 'Test line',
        ipAddress: '10.0.0.111',
        macAddress: '',
        port: 9100,
        workflowKey: 'ARN'
    };

    try {
        await connection.execute(
            'UPDATE arn_station_lock SET mo = ? WHERE printer_id = ?',
            ['ACTIVE-MO', 'PRINTER_D']
        );
        const blocked = await request(baseUrl, '/api/printer-setup/printers/PRINTER_A', {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        assert.equal(blocked.response.status, 409);

        let rows;
        [rows] = await connection.execute('SELECT printer_name FROM printer_devices WHERE printer_id = ?', ['PRINTER_A']);
        assert.equal(rows.length, 0, 'a blocked ARN reassignment must not save printer details');
        [rows] = await connection.execute('SELECT printer_id FROM workflow_printer_assignments WHERE workflow_key = ?', ['ARN']);
        assert.equal(rows[0].printer_id, 'PRINTER_D');

        await connection.execute('UPDATE arn_station_lock SET mo = NULL WHERE printer_id = ?', ['PRINTER_D']);
        const saved = await request(baseUrl, '/api/printer-setup/printers/PRINTER_A', {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        assert.equal(saved.response.status, 200, saved.payload.message);
        assert.equal(saved.payload.printer.name, payload.name);
        assert.equal(saved.payload.assignments.ARN.printerId, 'PRINTER_A');
        assert.equal(saved.payload.assignments.STANDARD.printerId, null);

        [rows] = await connection.execute(
            'SELECT printer_name, ip_address FROM printer_devices WHERE printer_id = ?',
            ['PRINTER_A']
        );
        assert.deepEqual(rows[0], { printer_name: payload.name, ip_address: payload.ipAddress });
        [rows] = await connection.execute('SELECT printer_id FROM arn_station_lock WHERE printer_id = ?', ['PRINTER_A']);
        assert.equal(rows.length, 1, 'the ARN station row is provisioned by the combined save');
        console.log('PASS: combined printer save is atomic and provisions the ARN station safely.');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
