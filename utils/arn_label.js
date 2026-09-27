/**
 * Builds the SBPL payload for one ARN label. This module never opens a socket
 * or prints on import; printer communication remains in utils/printer.js.
 */
const ESC = '\x1B';
const MAX_VERTICAL = 870; // 74.33 mm at 305 DPI
const FONT = ESC + 'XM';
const BARCODE = ESC + 'BG02060';
const QR_CODE = ESC + '2D30,M,05,1,0';
const QR_VERSION = ESC + 'QV07';
const SIDE_MARGIN = 78;

function printableAscii(value, fieldName) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error(fieldName + ' is required for an ARN label.');
    if (!/^[\x20-\x7E]+$/.test(text)) {
        throw new Error(fieldName + ' must contain printable ASCII characters only.');
    }
    return text;
}

function positiveInteger(value, fieldName) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(fieldName + ' must be a positive whole number.');
    }
    return number;
}

function nonNegativeInteger(value, fieldName) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(fieldName + ' must be zero or a positive whole number.');
    }
    return number;
}

/**
 * Creates the approved ARN layout as SBPL text. The returned payload is sent
 * by printLabel_arn, using whichever printer A-D the operator selected.
 */
function generateArnLabel({
    arnPartNumber, quantity, manufacturerPartNumber, purchaseOrder, dateCode,
    itemNo, manufacturerName, madeInText
}) {
    const arnPN = printableAscii(arnPartNumber, 'ARN P/N');
    const qty = positiveInteger(quantity, 'ARN quantity');
    const mfrPN = printableAscii(manufacturerPartNumber, 'Mfr P/N');
    const po = printableAscii(purchaseOrder, 'ARN PO');
    const date = printableAscii(dateCode, 'Date code');
    const mfrName = printableAscii(manufacturerName, 'Manufacturer name');
    const madeIn = printableAscii(madeInText, 'Made-in text');
    const serial = nonNegativeInteger(itemNo, 'Mfr Ref running number');
    const reference = date + '-' + serial.toString().padStart(6, '0');
    const displayFields = [
        { data: arnPN, label: '(P) ARN P/N:' },
        { data: String(qty), label: '(Q) QTY:' },
        { data: mfrPN, label: '(M) Mfr P/N:' },
        { data: date, label: '(D) Date Code:' },
        { data: po, label: '(K) PO:' },
        { data: mfrName, label: 'Mfr Name:', skipRow: true },
        { data: reference, label: 'Mfr Ref:', colOffset: 400 }
    ];
    // This preserves the supplied formatter: visible values are unprefixed,
    // P/Q/M/D/K prefixes are QR-only, and Mfr Ref is not in the QR payload.
    const qrCodeData = [
        'P' + arnPN,
        'Q' + qty,
        'M' + mfrPN,
        'D' + date,
        'K' + po,
        mfrName
    ].join(',');
    const qrLength = qrCodeData.length.toString().padStart(4, '0');
    const commands = [ESC + 'A', ESC + '%1'];
    let column = SIDE_MARGIN + 30;
    let row = SIDE_MARGIN + 50;
    const coordinate = (vertical, horizontal) => (
        ESC + 'V' + String(Math.max(0, MAX_VERTICAL - vertical)).padStart(4, '0') +
        ESC + 'H' + String(horizontal).padStart(4, '0')
    );

    for (const { data, label, colOffset = 0, skipRow = false } of displayFields) {
        const currentColumn = column + colOffset;
        commands.push(coordinate(currentColumn, row) + FONT + label + ' ' + data);
        commands.push(coordinate(currentColumn, row + 40) + BARCODE + data);
        if (!skipRow) row += 120;
    }

    commands.push(
        coordinate(column + 50, row + 50) +
        QR_CODE + QR_VERSION + ESC + 'DN' + qrLength + ',' + qrCodeData
    );
    commands.push(
        coordinate(column + 370, Math.round(row + 50 + 241 / 2)) +
        ESC + 'L0102' + ESC + FONT + madeIn
    );
    commands.push(ESC + 'Z');
    return commands.join('');
}

module.exports = { generateArnLabel };
