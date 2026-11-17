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
const db = require('../../db/root');
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
        assert.equal((await fetch(mainUrl + '/submit-data', {
            method: 'POST',
            headers: { Cookie: sessionCookie('OPERATOR'), 'Content-Type': 'application/json' },
            body: '{}'
        })).status, 400);
        assert.equal((await get(mainUrl, '/dashboard', 'SUPERVISOR')).status, 200);
        assert.equal((await get(mainUrl, '/arn/setup', 'ADMIN')).status, 200);
        assert.equal((await get(mainUrl, '/dashboard', 'OPERATOR')).status, 403);
        assert.equal((await get(mainUrl, '/api/management-dashboard/printers', 'OPERATOR')).status, 403);

        const connection = await db.getConnection();
        try {
            await connection.execute(
                'INSERT INTO product_code_ref (Product_name, Product_code, Manufacturing_ID, Customer_ID, Actmax_ID) VALUES (?, ?, ?, ?, ?)',
                ['Dashboard Standard Test Product', 'DASH-PROD', 'DASH-MFG', 'DASH-CUSTOMER', 'ACT-DASH-01']
            );
            await connection.execute(
                'INSERT INTO products_unique (date, mo, Cust_part_no, Act_part_no, product_code_group, Unique_serial, Label_content, printer_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                ['2026-11-17 10:30:00', 'MO-DASH-01', 'CUST-DASH-01', 'ACT-DASH-01', 'DASH-PROD-DASH-MFG-2647', '00001', 'DASH-PROD-DASH-MFG-264700001', 'PRINTER_A']
            );
        } finally {
            connection.release();
        }

        const standardQuery = new URLSearchParams({
            type: 'STANDARD', startDate: '2026-11-17', endDate: '2026-11-17',
            mo: 'MO-DASH-01', part: 'ACT-DASH-01', printer: 'PRINTER_A', search: 'DASH-PROD-DASH-MFG-264700001'
        });
        const standardResponse = await get(mainUrl, '/api/management-dashboard?' + standardQuery, 'SUPERVISOR');
        assert.equal(standardResponse.status, 200);
        const standardDashboard = await standardResponse.json();
        assert.equal(standardDashboard.filters.type, 'STANDARD');
        assert.equal(standardDashboard.summary.standardLabels, 1);
        assert.equal(standardDashboard.rows.length, 1);
        assert.equal(standardDashboard.rows[0].labelContent, 'DASH-PROD-DASH-MFG-264700001');
        assert.equal(standardDashboard.rows[0].productName, 'Dashboard Standard Test Product');

        const printerResponse = await get(mainUrl, '/api/management-dashboard/printers', 'SUPERVISOR');
        assert.equal(printerResponse.status, 200);
        const printerOptions = await printerResponse.json();
        assert.ok(printerOptions.printers.some(printer => printer.id === 'PRINTER_A'));

        const standardExport = await get(mainUrl, '/api/management-dashboard/export?' + standardQuery + '&format=csv', 'SUPERVISOR');
        assert.equal(standardExport.status, 200);
        const standardCsv = await standardExport.text();
        assert.match(standardCsv, /Product Label Content/);
        assert.match(standardCsv, /DASH-PROD-DASH-MFG-264700001/);

        const standardExcel = await get(mainUrl, '/api/management-dashboard/export?' + standardQuery + '&format=xlsx', 'SUPERVISOR');
        assert.equal(standardExcel.status, 200);
        const exportedWorkbook = new ExcelJS.Workbook();
        await exportedWorkbook.xlsx.load(Buffer.from(await standardExcel.arrayBuffer()));
        assert.deepEqual(exportedWorkbook.worksheets.map(worksheet => worksheet.name), ['Standard product labels']);
        assert.equal(exportedWorkbook.worksheets[0].getRow(2).getCell(2).value, 'DASH-PROD-DASH-MFG-264700001');

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

        console.log('PASS: role restrictions, Standard dashboard filters/exports, and Excel ingestion audit log verified.');
    } finally {
        await new Promise(resolve => mainServer.close(resolve));
        await new Promise(resolve => excelServer.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
