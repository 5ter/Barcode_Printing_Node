const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('../db/root');

const router = express.Router();
const ASSET_DIRECTORY = path.join(__dirname, '..', 'views', 'management-dashboard-assets');
const MAX_PAGE_SIZE = 100;
const EXPORT_BATCH_SIZE = 1000;

router.use('/dashboard-assets', express.static(ASSET_DIRECTORY));

router.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'views', 'managementDashboard.html'));
});

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readFilters(query) {
    const startDate = String(query.startDate || '').trim();
    const endDate = String(query.endDate || '').trim();
    if (!validDate(startDate) || !validDate(endDate)) {
        return { error: 'Choose a valid start and end date.' };
    }
    if (startDate > endDate) {
        return { error: 'Start date cannot be after end date.' };
    }

    const printer = String(query.printer || '').trim().toUpperCase();
    if (printer && !/^PRINTER_[A-Z0-9][A-Z0-9_-]{0,35}$/.test(printer)) {
        return { error: 'Choose a valid printer.' };
    }

    const view = String(query.view || 'cartons').trim().toLowerCase();
    if (view !== 'cartons' && view !== 'products') {
        return { error: 'Choose either the carton or product view.' };
    }

    const pageValue = Number.parseInt(query.page, 10);
    const pageSizeValue = Number.parseInt(query.pageSize, 10);
    const pageSize = [25, 50, 100].includes(pageSizeValue) ? pageSizeValue : 25;
    const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? Math.min(pageValue, 100000) : 1;

    return {
        filters: {
            startDate,
            endDate,
            mo: String(query.mo || '').trim().slice(0, 100),
            part: String(query.part || '').trim().slice(0, 255),
            search: String(query.search || '').trim().slice(0, 255),
            printer,
            view,
            page,
            pageSize
        }
    };
}

function addDateFilter(where, parameters, column, filters) {
    where.push(column + ' >= ?');
    parameters.push(filters.startDate + ' 00:00:00');
    where.push(column + ' <= ?');
    parameters.push(filters.endDate + ' 23:59:59');
}

function addExactContainsFilter(where, parameters, column, value) {
    if (!value) return;
    where.push(column + ' LIKE ?');
    parameters.push('%' + value + '%');
}

function addAnyContainsFilter(where, parameters, columns, value) {
    if (!value) return;
    where.push('(' + columns.map(column => column + ' LIKE ?').join(' OR ') + ')');
    for (const unusedColumn of columns) parameters.push('%' + value + '%');
}

// mysql2 sends JavaScript numbers as DOUBLE in prepared statements. MySQL
// expects integer-compatible LIMIT/OFFSET values, so pass these validated values as decimal strings.
// All user-entered filters remain parameter-bound.
function paginationParameters(limit, offset) {
    if (!Number.isSafeInteger(limit) || limit < 1 ||
        !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('Invalid dashboard pagination values.');
    }
    return [String(limit), String(offset)];
}

function makeCartonFilter(filters) {
    const where = [];
    const parameters = [];
    addDateFilter(where, parameters, 'h.printed_at', filters);
    addExactContainsFilter(where, parameters, 'h.mo', filters.mo);
    addAnyContainsFilter(where, parameters, ['h.arn_part_no', 'h.manufacturer_part_no'], filters.part);
    addExactContainsFilter(where, parameters, 'h.printer_id', filters.printer);
    addAnyContainsFilter(where, parameters, [
        'h.label_content', 'h.mo', 'h.arn_part_no', 'h.manufacturer_part_no',
        'h.purchase_order', 'h.printer_id', 'h.print_status'
    ], filters.search);
    return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', parameters };
}

function makeStandardProductFilter(filters) {
    const where = [];
    const parameters = [];
    addDateFilter(where, parameters, 'p.date', filters);
    addExactContainsFilter(where, parameters, 'p.mo', filters.mo);
    addAnyContainsFilter(where, parameters, ['p.Act_part_no', 'p.Cust_part_no'], filters.part);
    addExactContainsFilter(where, parameters, 'p.printer_ID', filters.printer);
    addAnyContainsFilter(where, parameters, [
        'p.Label_content', 'p.mo', 'p.Act_part_no', 'p.Cust_part_no',
        'p.product_code_group', 'CAST(p.Unique_serial AS CHAR)', 'p.printer_ID'
    ], filters.search);
    return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', parameters };
}

function makeArnProductFilter(filters) {
    const where = [];
    const parameters = [];
    addDateFilter(where, parameters, 's.scanned_at', filters);
    addExactContainsFilter(where, parameters, 'c.mo', filters.mo);
    addAnyContainsFilter(where, parameters, ['c.arn_part_no', 'c.manufacturer_part_no'], filters.part);
    addExactContainsFilter(where, parameters, 'c.printer_id', filters.printer);
    addAnyContainsFilter(where, parameters, [
        's.scanned_content', 'c.mo', 'c.arn_part_no', 'c.manufacturer_part_no',
        'c.purchase_order', 'c.printer_id', 'h.label_content', 'CAST(c.id AS CHAR)'
    ], filters.search);
    return { sql: ' WHERE ' + where.join(' AND '), parameters };
}

function cartonSelect(filter, withPagination) {
    return {
        sql: `SELECT
                h.id AS printHistoryId,
                COALESCE(c.id, h.carton_id) AS cartonId,
                h.mo AS mo,
                h.arn_part_no AS arnPartNo,
                h.manufacturer_part_no AS manufacturerPartNo,
                h.purchase_order AS purchaseOrder,
                h.quantity AS labelQuantity,
                c.box_capacity AS boxCapacity,
                COALESCE(c.scanned_count, 0) AS scannedCount,
                c.status AS cartonStatus,
                h.date_code AS dateCode,
                h.item_no AS itemNo,
                h.label_content AS labelReference,
                h.print_status AS printStatus,
                h.retry_count AS retryCount,
                h.last_error AS lastError,
                h.printer_id AS printerId,
                h.printed_at AS printedAt,
                (SELECT COUNT(*) FROM arn_carton_scans active_scan
                 WHERE active_scan.carton_id = c.id AND active_scan.removed_at IS NULL) AS activeScanCount
            FROM arn_label_print_history h
            LEFT JOIN arn_cartons c ON c.id = h.carton_id OR c.label_history_id = h.id${filter.sql}
            ORDER BY h.printed_at DESC, h.id DESC${withPagination ? ' LIMIT ? OFFSET ?' : ''}`,
        parameters: filter.parameters
    };
}

function standardProductSelect(filter) {
    return `SELECT
                'STANDARD LABEL' AS recordType,
                p.id AS recordId,
                p.date AS eventAt,
                p.mo AS mo,
                p.Act_part_no AS partNo,
                p.Cust_part_no AS customerPartNo,
                NULL AS manufacturerPartNo,
                NULL AS purchaseOrder,
                p.Label_content AS labelContent,
                CAST(p.Unique_serial AS CHAR) AS serialNo,
                NULL AS cartonId,
                NULL AS cartonLabelReference,
                p.printer_ID AS printerId,
                'PRINTED' AS recordStatus
            FROM products_unique p${filter.sql}`;
}

function arnProductSelect(filter) {
    return `SELECT
                'ARN UNIT SCAN' AS recordType,
                s.id AS recordId,
                s.scanned_at AS eventAt,
                c.mo AS mo,
                c.arn_part_no AS partNo,
                NULL AS customerPartNo,
                c.manufacturer_part_no AS manufacturerPartNo,
                c.purchase_order AS purchaseOrder,
                s.scanned_content AS labelContent,
                NULL AS serialNo,
                c.id AS cartonId,
                h.label_content AS cartonLabelReference,
                c.printer_id AS printerId,
                CASE WHEN s.removed_at IS NULL THEN 'IN CARTON' ELSE 'REMOVED' END AS recordStatus
            FROM arn_carton_scans s
            INNER JOIN arn_cartons c ON c.id = s.carton_id
            LEFT JOIN arn_label_print_history h ON h.id = c.label_history_id${filter.sql}`;
}

function productUnion(standardFilter, arnFilter) {
    return standardProductSelect(standardFilter) + '\nUNION ALL\n' + arnProductSelect(arnFilter);
}

async function readCounts(connection, cartonFilter, standardFilter, arnFilter) {
    const [cartonRows] = await connection.execute(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN h.print_status = 'SENT' THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN h.print_status = 'FAILED' THEN 1 ELSE 0 END) AS failed
         FROM arn_label_print_history h${cartonFilter.sql}`,
        cartonFilter.parameters
    );
    const [standardRows] = await connection.execute(
        'SELECT COUNT(*) AS total FROM products_unique p' + standardFilter.sql,
        standardFilter.parameters
    );
    const [arnScanRows] = await connection.execute(
        'SELECT COUNT(*) AS total FROM arn_carton_scans s INNER JOIN arn_cartons c ON c.id = s.carton_id ' +
            'LEFT JOIN arn_label_print_history h ON h.id = c.label_history_id' + arnFilter.sql,
        arnFilter.parameters
    );

    const carton = cartonRows[0] || {};
    const standardLabels = Number(standardRows[0] && standardRows[0].total || 0);
    const arnUnitScans = Number(arnScanRows[0] && arnScanRows[0].total || 0);
    return {
        cartonLabels: Number(carton.total || 0),
        cartonLabelsSent: Number(carton.sent || 0),
        cartonPrintFailures: Number(carton.failed || 0),
        standardLabels,
        arnUnitScans,
        productRecords: standardLabels + arnUnitScans
    };
}

router.get('/api/management-dashboard', async (req, res) => {
    const parsed = readFilters(req.query);
    if (parsed.error) return res.status(400).json({ status: 'error', message: parsed.error });

    const filters = parsed.filters;
    const cartonFilter = makeCartonFilter(filters);
    const standardFilter = makeStandardProductFilter(filters);
    const arnFilter = makeArnProductFilter(filters);
    let connection;

    try {
        connection = await db.getConnection();
        const summary = await readCounts(connection, cartonFilter, standardFilter, arnFilter);
        const offset = (filters.page - 1) * filters.pageSize;
        let rows;
        let total;

        if (filters.view === 'cartons') {
            total = summary.cartonLabels;
            const query = cartonSelect(cartonFilter, true);
            const [resultRows] = await connection.execute(
                query.sql,
                [...query.parameters, ...paginationParameters(filters.pageSize, offset)]
            );
            rows = resultRows;
        } else {
            total = summary.productRecords;
            const [resultRows] = await connection.execute(
                `SELECT * FROM (${productUnion(standardFilter, arnFilter)}) AS product_records
                 ORDER BY eventAt DESC, recordId DESC
                 LIMIT ? OFFSET ?`,
                [...standardFilter.parameters, ...arnFilter.parameters,
                    ...paginationParameters(filters.pageSize, offset)]
            );
            rows = resultRows;
        }

        return res.json({
            status: 'success',
            filters,
            summary,
            rows,
            pagination: {
                page: filters.page,
                pageSize: filters.pageSize,
                total,
                totalPages: Math.ceil(total / filters.pageSize)
            }
        });
    } catch (error) {
        console.error('Management dashboard query failed:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Could not load the label audit records. Check the database connection and required ARN carton tables.'
        });
    } finally {
        if (connection) connection.release();
    }
});

router.get('/api/management-dashboard/cartons/:cartonId/scans', async (req, res) => {
    const cartonId = String(req.params.cartonId || '').trim();
    if (!/^[1-9]\d*$/.test(cartonId)) {
        return res.status(400).json({ status: 'error', message: 'A valid carton ID is required.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        const [rows] = await connection.execute(
            `SELECT id AS scanId, scanned_content AS scannedContent,
                    scanned_at AS scannedAt, removed_at AS removedAt
             FROM arn_carton_scans WHERE carton_id = ? ORDER BY id ASC`,
            [cartonId]
        );
        return res.json({ status: 'success', rows });
    } catch (error) {
        console.error('Management dashboard carton detail query failed:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Could not load the product scan history for this carton.'
        });
    } finally {
        if (connection) connection.release();
    }
});

function csvCell(value) {
    if (value === null || value === undefined) return '""';
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}

function csvRow(values) {
    return values.map(csvCell).join(',') + '\r\n';
}

function waitForDrainOrClose(response) {
    return new Promise(resolve => {
        const cleanup = () => {
            response.removeListener('drain', onDrain);
            response.removeListener('close', onClose);
        };
        const onDrain = () => { cleanup(); resolve(true); };
        const onClose = () => { cleanup(); resolve(false); };
        response.once('drain', onDrain);
        response.once('close', onClose);
    });
}

async function streamQueryAsCsv(connection, baseSql, parameters, columns, res) {
    let offset = 0;
    while (!res.destroyed) {
        const [rows] = await connection.execute(
            baseSql + ' LIMIT ? OFFSET ?',
            [...parameters, ...paginationParameters(EXPORT_BATCH_SIZE, offset)]
        );
        if (rows.length === 0) return;

        for (const row of rows) {
            const writable = res.write(csvRow(columns.map(column => row[column])));
            if (!writable) {
                const canContinue = await waitForDrainOrClose(res);
                if (!canContinue || res.destroyed) return;
            }
        }
        if (rows.length < EXPORT_BATCH_SIZE) return;
        offset += rows.length;
    }
}

async function streamQueryAsExcel(connection, baseSql, parameters, columns, worksheet, response) {
    let offset = 0;
    while (!response.destroyed) {
        const [rows] = await connection.execute(
            baseSql + ' LIMIT ? OFFSET ?',
            [...parameters, ...paginationParameters(EXPORT_BATCH_SIZE, offset)]
        );
        if (rows.length === 0) return;

        for (const row of rows) {
            worksheet.addRow(columns.map(column => row[column])).commit();
        }
        if (rows.length < EXPORT_BATCH_SIZE) return;
        offset += rows.length;
    }
}

router.get('/api/management-dashboard/export', async (req, res) => {
    const parsed = readFilters(req.query);
    if (parsed.error) return res.status(400).json({ status: 'error', message: parsed.error });

    const filters = parsed.filters;
    const format = String(req.query.format || 'xlsx').trim().toLowerCase();
    if (format !== 'xlsx' && format !== 'csv') {
        return res.status(400).json({ status: 'error', message: 'Choose CSV or Excel format.' });
    }
    const dateTag = filters.startDate + '_to_' + filters.endDate;
    const cartonFilter = makeCartonFilter(filters);
    const standardFilter = makeStandardProductFilter(filters);
    const arnFilter = makeArnProductFilter(filters);
    let connection;

    try {
        connection = await db.getConnection();
        const viewName = filters.view === 'cartons' ? 'cartons' : 'products';
        res.status(200);
        const excelColumns = filters.view === 'cartons' ? [
            ['Print History ID', 'printHistoryId'], ['Carton ID', 'cartonId'],
            ['ARN Label Reference', 'labelReference'], ['MO', 'mo'], ['ARN Part No.', 'arnPartNo'],
            ['Manufacturer Part No.', 'manufacturerPartNo'], ['Purchase Order', 'purchaseOrder'],
            ['Label Quantity', 'labelQuantity'], ['Carton Capacity', 'boxCapacity'],
            ['Scanned Count', 'scannedCount'], ['Carton Status', 'cartonStatus'],
            ['Print Status', 'printStatus'], ['Printer', 'printerId'], ['Printed At', 'printedAt'],
            ['Date Code', 'dateCode'], ['Item No.', 'itemNo'], ['Retry Count', 'retryCount'],
            ['Last Error', 'lastError']
        ] : [
            ['Record Type', 'recordType'], ['Record ID', 'recordId'], ['Date & Time', 'eventAt'],
            ['MO', 'mo'], ['Part No.', 'partNo'], ['Customer Part No.', 'customerPartNo'],
            ['Manufacturer Part No.', 'manufacturerPartNo'], ['Purchase Order', 'purchaseOrder'],
            ['Label / Scanned Content', 'labelContent'], ['Serial No.', 'serialNo'],
            ['Carton ID', 'cartonId'], ['Carton Label Reference', 'cartonLabelReference'],
            ['Printer', 'printerId'], ['Record Status', 'recordStatus']
        ];

        if (format === 'xlsx') {
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="label_${viewName}_${dateTag}.xlsx"`);
            const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
                stream: res,
                useStyles: true,
                useSharedStrings: true
            });
            const worksheet = workbook.addWorksheet(filters.view === 'cartons' ? 'Carton labels' : 'Product records');
            worksheet.columns = excelColumns.map(([header]) => ({
                header,
                width: Math.min(34, Math.max(12, header.length + 3))
            }));
            worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123B83' } };
            worksheet.views = [{ state: 'frozen', ySplit: 1 }];
            worksheet.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: excelColumns.length }
            };

            if (filters.view === 'cartons') {
                const query = cartonSelect(cartonFilter);
                await streamQueryAsExcel(
                    connection, query.sql, query.parameters,
                    excelColumns.map(([, key]) => key), worksheet, res
                );
            } else {
                const query = `SELECT * FROM (${productUnion(standardFilter, arnFilter)}) AS product_records
                               ORDER BY eventAt DESC, recordId DESC`;
                await streamQueryAsExcel(
                    connection, query, [...standardFilter.parameters, ...arnFilter.parameters],
                    excelColumns.map(([, key]) => key), worksheet, res
                );
            }
            await workbook.commit();
            return;
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="label_${viewName}_${dateTag}.csv"`);
        res.write('\uFEFF');
        if (filters.view === 'cartons') {
            res.write(csvRow(excelColumns.map(([header]) => header)));
            const query = cartonSelect(cartonFilter);
            await streamQueryAsCsv(connection, query.sql, query.parameters, excelColumns.map(([, key]) => key), res);
        } else {
            res.write(csvRow(excelColumns.map(([header]) => header)));
            const query = `SELECT * FROM (${productUnion(standardFilter, arnFilter)}) AS product_records
                           ORDER BY eventAt DESC, recordId DESC`;
            await streamQueryAsCsv(
                connection,
                query,
                [...standardFilter.parameters, ...arnFilter.parameters],
                excelColumns.map(([, key]) => key),
                res
            );
        }

        if (!res.destroyed) res.end();
    } catch (error) {
        console.error('Management dashboard CSV export failed:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                status: 'error',
                message: 'Could not export the filtered records.'
            });
        }
        if (!res.destroyed) res.destroy(error);
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
