'use strict';

// Run with: node tests/manual/access-and-ingestion.smoke.js
// Uses disposable SQLite storage and exercises role protection plus a real
// workbook import/audit-log read without contacting a printer.
const assert = require('assert/strict');
const ExcelJS = require('exceljs');

process.env.NODE_ENV = 'test';
process.env.AUTH_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';

const { COOKIE_NAME, createSessionToken } = require('../../utils/auth');
const mainApp = require('../../apps');
const excelApp = require('../../app_excel');

function sessionCookie(role) {
    return COOKIE_NAME + '=' + encodeURIComponent(createSessionToken(role));
}

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function get(baseUrl, pathName, role) {
    return fetch(baseUrl + pathName, {
        headers: { Cookie: sessionCookie(role) },
        redirect: 'manual'
    });
}

async function main() {
    const mainServer = await listen(mainApp);
    const excelServer = await listen(excelApp);
    const mainUrl = 'http://127.0.0.1:' + mainServer.address().port;
    const excelUrl = 'http://127.0.0.1:' + excelServer.address().port;

    try {
        assert.equal((await get(mainUrl, '/arn/setup', 'SUPERVISOR')).status, 403);
        assert.equal((await get(mainUrl, '/standard', 'SUPERVISOR')).status, 403);
        assert.equal((await fetch(mainUrl + '/submit-data', {
            method: 'POST',
            headers: { Cookie: sessionCookie('SUPERVISOR'), 'Content-Type': 'application/json' },
            body: '{}'
        })).status, 403);
        assert.equal((await get(mainUrl, '/dashboard', 'SUPERVISOR')).status, 200);
        assert.equal((await get(mainUrl, '/arn/setup', 'ADMIN')).status, 200);
        assert.equal((await get(mainUrl, '/dashboard', 'OPERATOR')).status, 403);

        const uploaderHtml = await (await get(excelUrl, '/', 'SUPERVISOR')).text();
        assert.equal(uploaderHtml.includes('Ready to Commit'), false);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Import');
        worksheet.addRow(['product_name', 'product_code', 'manufacturing_id', 'customer_id', 'actmax_id']);
        worksheet.addRow(['Audit test product', 'PRODUCT-01', 'MO-01', 'CUSTOMER-01', 'ACT-01']);
        const form = new FormData();
        form.append(
            'excelFile',
            new Blob([await workbook.xlsx.writeBuffer()], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }),
            'audit-test.xlsx'
        );

        const upload = await fetch(excelUrl + '/upload', {
            method: 'POST',
            headers: { Cookie: sessionCookie('SUPERVISOR') },
            body: form
        });
        assert.equal(upload.status, 200, await upload.text());

        const logResponse = await get(excelUrl, '/api/ingestion-log', 'SUPERVISOR');
        assert.equal(logResponse.status, 200);
        const log = await logResponse.json();
        assert.equal(log.status, 'success');
        assert.equal(log.rows.length, 1);
        assert.equal(log.rows[0].sourceFileName, 'audit-test.xlsx');
        assert.equal(log.rows[0].schemaType, 'STANDARD');
        assert.equal(log.rows[0].rowsProcessed, 1);
        assert.equal(log.rows[0].uploadedBy, 'SUPERVISOR');
        assert.equal((await get(excelUrl, '/api/ingestion-log', 'OPERATOR')).status, 403);

        console.log('PASS: role restrictions and persisted Excel ingestion audit log verified.');
    } finally {
        await new Promise(resolve => mainServer.close(resolve));
        await new Promise(resolve => excelServer.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
