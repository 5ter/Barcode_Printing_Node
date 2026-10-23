document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.arnPage;
    let printer = '';

    const standardLink = document.getElementById('standardLink');
    if (standardLink) standardLink.href = '/standard';
    const setupLink = document.getElementById('setupLink');
    if (setupLink) setupLink.href = '/arn/setup';
    const excelUploadLink = document.getElementById('excelUploadLink');
    if (excelUploadLink) {
        const uploadUrl = new URL(window.location.href);
        uploadUrl.port = '3005';
        uploadUrl.pathname = '/';
        uploadUrl.search = '';
        uploadUrl.hash = '';
        excelUploadLink.href = uploadUrl.toString();
    }

    const api = async (path, method = 'GET', data) => {
        const options = { method, headers: {} };
        if (data) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(data);
        }
        const response = await fetch(path, options);
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(result.message || 'Request failed with status ' + response.status);
            error.payload = result;
            error.status = response.status;
            throw error;
        }
        return result;
    };

    const displayAlert = (element, text, kind = 'info') => {
        element.textContent = text;
        element.className = 'arn-alert visible arn-alert-' + kind;
    };

    async function startWorkflow() {
        const alert = document.getElementById(page === 'setup' ? 'setupAlert' : 'scanAlert');
        try {
            const result = await api('/api/workflow-printers');
            const assignment = result.assignments && result.assignments.ARN;
            if (!assignment || !assignment.printerLetter) {
                throw new Error('No printer is assigned to the ARN workflow. Open Printer Setup to assign one.');
            }
            printer = assignment.printerLetter;
            const assignedName = document.getElementById('assignedPrinterName');
            if (assignedName) assignedName.textContent = 'Printer ' + printer + ' · ' + assignment.printerName;
            if (page === 'setup') await initializeSetup();
            if (page === 'scan') await initializeScan();
        } catch (error) {
            if (alert) displayAlert(alert, error.message, 'error');
            if (page === 'setup') document.getElementById('lockButton').disabled = true;
            if (page === 'scan') {
                ['barcodeInput', 'scanButton', 'completeButton', 'retryButton', 'nextCartonButton', 'unlockButton']
                    .forEach(id => {
                        const element = document.getElementById(id);
                        if (element) element.disabled = true;
                    });
            }
            const assignedName = document.getElementById('assignedPrinterName');
            if (assignedName) assignedName.textContent = 'Assignment unavailable';
        }
    }

    startWorkflow();

    async function initializeSetup() {
        const alert = document.getElementById('setupAlert');
        const form = document.getElementById('arnLockForm');
        const lockButton = document.getElementById('lockButton');
        const moInput = document.getElementById('moInput');
        const mpnInput = document.getElementById('mpnInput');
        const lockCard = document.getElementById('activeLockCard');
        const resumeLink = document.getElementById('resumeLink');
        document.getElementById('activePrinterName').textContent = printer;
        resumeLink.href = '/arn/scan';

        let stationState;
        try {
            const result = await api('/arn/api/state');
            stationState = result.state;
            if (stationState.active) {
                lockCard.classList.add('visible');
                document.getElementById('activeLockText').textContent =
                    'Locked to MO ' + stationState.lock.mo + ' · ' + stationState.lock.manufacturer_part_no;
                document.getElementById('activeCartonText').textContent = stationState.carton
                    ? 'Current carton: #' + stationState.carton.id + ' · ' + stationState.carton.scanned_count + '/' + stationState.carton.box_capacity + ' scanned · ' + stationState.carton.status
                    : 'The saved carton state needs attention.';
                moInput.value = stationState.lock.mo;
                mpnInput.value = stationState.lock.manufacturer_part_no;
                moInput.disabled = true;
                mpnInput.disabled = true;
                lockButton.disabled = true;
                lockButton.textContent = 'Printer is locked — resume or finish the active carton';
                displayAlert(alert, 'This printer already has a saved ARN job. Resume it to continue; the lock will remain until the job is finished.', 'info');
                setMetadata({
                    arn_part_no: stationState.lock.arn_part_no,
                    purchase_order: stationState.lock.purchase_order,
                    quantity: stationState.lock.box_capacity
                });
            } else {
                moInput.focus();
            }
        } catch (error) {
            displayAlert(alert, error.message, 'error');
            lockButton.disabled = true;
        }

        const recentRows = document.getElementById('recentCartonRows');
        const recentCount = document.getElementById('recentCartonCount');

        function appendCell(row, value, className) {
            const cell = document.createElement('td');
            if (className) cell.className = className;
            if (value instanceof Node) cell.appendChild(value);
            else cell.textContent = value;
            row.appendChild(cell);
            return cell;
        }

        function statusClass(status) {
            const suffix = String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
            return suffix ? 'arn-status-' + suffix : 'arn-status-unknown';
        }

        function renderRecentCartons(cartons) {
            recentRows.replaceChildren();
            recentCount.textContent = cartons.length + ' recent carton' + (cartons.length === 1 ? '' : 's');
            if (!cartons.length) {
                const emptyRow = document.createElement('tr');
                appendCell(emptyRow, 'No cartons have been created at this ARN station yet.', 'arn-table-empty').colSpan = 5;
                recentRows.appendChild(emptyRow);
                return;
            }

            for (const carton of cartons) {
                const row = document.createElement('tr');
                const labelCell = document.createElement('td');
                const cartonCode = document.createElement('span');
                cartonCode.className = 'arn-table-code';
                cartonCode.textContent = 'Carton #' + carton.id;
                const reference = document.createElement('span');
                reference.className = 'arn-table-subtext';
                reference.textContent = carton.labelReference || 'Label not printed yet';
                labelCell.append(cartonCode, reference);
                row.appendChild(labelCell);

                const partCell = document.createElement('td');
                const mo = document.createElement('strong');
                mo.textContent = carton.mo || '—';
                const part = document.createElement('span');
                part.className = 'arn-table-subtext';
                part.textContent = carton.arnPartNo || carton.manufacturerPartNo || '—';
                partCell.append(mo, part);
                row.appendChild(partCell);

                const units = document.createElement('span');
                units.className = 'arn-table-units';
                units.textContent = String(carton.printedQuantity == null ? carton.scannedCount : carton.printedQuantity);
                const capacity = document.createElement('span');
                capacity.className = 'arn-table-capacity';
                capacity.textContent = ' / ' + String(carton.boxCapacity);
                const unitsCell = document.createElement('td');
                unitsCell.append(units, capacity);
                row.appendChild(unitsCell);

                const status = document.createElement('span');
                status.className = 'arn-status ' + statusClass(carton.status);
                status.textContent = String(carton.status || 'Unknown').replace(/_/g, ' ');
                appendCell(row, status);

                const actionCell = document.createElement('td');
                if (carton.canReprint) {
                    const reprint = document.createElement('button');
                    reprint.type = 'button';
                    reprint.className = 'arn-button arn-button-secondary arn-table-button';
                    reprint.textContent = 'Reprint';
                    reprint.title = 'Send the original saved label again';
                    reprint.addEventListener('click', async () => {
                        const referenceText = carton.labelReference || ('for Carton #' + carton.id);
                        if (!window.confirm('Reprint ARN label ' + referenceText + ' to Printer ' + printer + '? This sends one additional copy with the same saved reference.')) return;
                        reprint.disabled = true;
                        try {
                            const result = await api('/arn/api/cartons/' + encodeURIComponent(carton.id) + '/reprint', 'POST', {});
                            displayAlert(alert, 'Reprinted the same ARN reference: ' + result.labelReference, 'success');
                            await loadRecentCartons();
                        } catch (error) {
                            displayAlert(alert, error.message, 'error');
                            reprint.disabled = false;
                        }
                    });
                    actionCell.appendChild(reprint);
                } else if (stationState && stationState.carton && String(stationState.carton.id) === String(carton.id) && carton.status !== 'SEALED') {
                    const resume = document.createElement('a');
                    resume.className = 'arn-button arn-button-primary arn-table-button';
                    resume.href = '/arn/scan';
                    resume.textContent = 'Resume';
                    actionCell.appendChild(resume);
                } else {
                    actionCell.textContent = carton.status === 'SEALED' ? 'No saved payload' : '—';
                }
                row.appendChild(actionCell);
                recentRows.appendChild(row);
            }
        }

        async function loadRecentCartons() {
            try {
                const result = await api('/arn/api/recent-cartons');
                renderRecentCartons(result.cartons || []);
            } catch (error) {
                recentRows.replaceChildren();
                const errorRow = document.createElement('tr');
                appendCell(errorRow, error.message, 'arn-table-empty').colSpan = 5;
                recentRows.appendChild(errorRow);
                recentCount.textContent = 'History unavailable';
            }
        }

        await loadRecentCartons();

        let lookupTimer;
        mpnInput.addEventListener('input', () => {
            clearTimeout(lookupTimer);
            lookupTimer = setTimeout(async () => {
                const partNo = mpnInput.value.trim();
                if (!partNo || stationState?.active) {
                    if (!stationState?.active) resetMetadata();
                    return;
                }
                try {
                    const lookup = await api('/arn/api/lookup?manufacturerPartNo=' + encodeURIComponent(partNo));
                    setMetadata(lookup.data);
                    document.getElementById('lookupBadge').textContent = 'Matched from Excel';
                } catch (error) {
                    resetMetadata();
                    if (error.status !== 404) displayAlert(alert, error.message, 'error');
                    document.getElementById('lookupBadge').textContent = error.status === 404 ? 'No match' : 'Lookup failed';
                }
            }, 250);
        });

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            lockButton.disabled = true;
            lockButton.textContent = 'Saving printer lock…';
            try {
                const result = await api('/arn/api/lock', 'POST', {
                    mo: moInput.value.trim(),
                    manufacturerPartNo: mpnInput.value.trim()
                });
                window.location.assign('/arn/scan');
            } catch (error) {
                displayAlert(alert, error.message, 'error');
                lockButton.disabled = false;
                lockButton.textContent = 'Lock Active Carton & Continue to Scanning';
            }
        });
    }

    function setMetadata(data) {
        document.getElementById('arnPartNo').textContent = data.arn_part_no || '—';
        document.getElementById('purchaseOrder').textContent = data.purchase_order || '—';
        document.getElementById('boxCapacity').textContent = data.quantity ? String(data.quantity) : '—';
        document.getElementById('lookupBadge').textContent = data.arn_part_no ? 'Matched from Excel' : 'Waiting for part';
    }

    function resetMetadata() {
        setMetadata({});
    }

    async function initializeScan() {
        const alert = document.getElementById('scanAlert');
        const scanForm = document.getElementById('scanForm');
        const scanInput = document.getElementById('barcodeInput');
        const scanButton = document.getElementById('scanButton');
        const completeButton = document.getElementById('completeButton');
        const retryButton = document.getElementById('retryButton');
        const nextButton = document.getElementById('nextCartonButton');
        const unlockButton = document.getElementById('unlockButton');
        let state = null;

        async function refreshState() {
            const result = await api('/arn/api/state');
            state = result.state;
            renderState();
        }

        function renderState() {
            if (!state || !state.active || !state.carton) {
                displayAlert(alert, 'No ARN job is locked to Printer ' + printer + '. Set up the MO and part first.', 'info');
                document.getElementById('cartonDisplay').textContent = 'No active carton';
                scanInput.disabled = true;
                scanButton.disabled = true;
                completeButton.disabled = true;
                nextButton.classList.add('arn-hidden');
                unlockButton.classList.add('arn-hidden');
                return;
            }

            alert.className = 'arn-alert';
            const carton = state.carton;
            const count = Number(carton.scanned_count) || 0;
            const capacity = Number(carton.box_capacity) || 0;
            const percent = capacity ? Math.min(100, Math.round(count * 100 / capacity)) : 0;
            document.getElementById('cartonDisplay').textContent = 'Carton #' + carton.id;
            document.getElementById('lockedMo').textContent = carton.mo;
            document.getElementById('lockedMpn').textContent = carton.manufacturer_part_no;
            document.getElementById('lockedArnPart').textContent = carton.arn_part_no;
            document.getElementById('lockedPrinterPo').textContent = printer + ' · ' + carton.purchase_order;
            document.getElementById('progressText').textContent = count + ' / ' + capacity + ' Units';
            document.getElementById('progressPercent').textContent = percent + '%';
            document.getElementById('progressBar').style.width = percent + '%';
            document.getElementById('remainingText').textContent = count >= capacity
                ? 'Carton capacity reached.'
                : (capacity - count) + ' units remaining to carton capacity';
            document.getElementById('cartonStatus').textContent = carton.status.replace('_', ' ');
            document.getElementById('scanCountBadge').textContent = count + ' units';
            document.getElementById('scanListSubheading').textContent = count + ' active scans · carton capacity ' + capacity;

            const scanIsOpen = carton.status === 'OPEN' && count < capacity;
            scanInput.disabled = !scanIsOpen;
            scanButton.disabled = !scanIsOpen;
            completeButton.disabled = !scanIsOpen || count === 0;
            completeButton.classList.toggle('arn-hidden', !scanIsOpen);
            nextButton.classList.toggle('arn-hidden', carton.status !== 'SEALED');
            const canUnlock = carton.status === 'SEALED' || (carton.status === 'OPEN' && count === 0);
            unlockButton.classList.toggle('arn-hidden', !canUnlock);
            retryButton.classList.toggle('arn-hidden', !['PRINT_FAILED', 'PRINTING'].includes(carton.status));
            const printPending = carton.status === 'PRINTING' || carton.status === 'PRINT_FAILED';
            if (carton.status === 'OPEN') {
                displayAlert(alert, 'Ready to scan. Every scan is saved to this carton; repeated scans appear as separate entries and can be removed before sealing.', 'info');
            } else if (carton.status === 'PRINT_FAILED') {
                displayAlert(alert, 'The carton is full or sealed for completion, but the ARN label failed to send. Retry the saved reference before proceeding.', 'error');
            } else if (carton.status === 'PRINTING') {
                displayAlert(alert, 'The ARN label has a saved reference and is awaiting confirmation. Retry only after checking the printer for a label already emitted.', 'info');
            } else {
                const reference = state.printHistory && state.printHistory.label_content;
                const qty = state.printHistory ? state.printHistory.quantity : count;
                displayAlert(alert, 'Carton sealed. ARN reference ' + (reference || 'saved') + ' · printed QTY ' + (qty || count) + '. Proceed to another carton or finish this MO.', 'success');
            }
            document.getElementById('actionHelp').textContent = carton.status === 'OPEN'
                ? 'A full carton prints automatically. For a final partial carton, press Complete & Seal; the label QTY will be the actual scanned count.'
                : 'The carton is locked against additional scans until you proceed or finish the MO.';
            renderScans(state.scans || [], scanIsOpen);
            if (scanIsOpen) scanInput.focus();
            if (printPending && !state.printHistory) retryButton.disabled = true;
            else retryButton.disabled = false;
        }

        function renderScans(scans, canEdit) {
            const list = document.getElementById('scannedSerialList');
            list.replaceChildren();
            if (!scans.length) {
                const empty = document.createElement('div');
                empty.className = 'arn-scan-empty';
                empty.textContent = 'No product labels recorded in this carton yet.';
                list.appendChild(empty);
                return;
            }
            for (const scan of scans) {
                const row = document.createElement('div');
                row.className = 'arn-scan-item';
                const textBlock = document.createElement('div');
                textBlock.style.minWidth = '0';
                const code = document.createElement('span');
                code.className = 'arn-scan-value';
                code.textContent = scan.scanned_content;
                const time = document.createElement('span');
                time.className = 'arn-scan-time';
                time.textContent = scan.scanned_at ? String(scan.scanned_at) : '';
                textBlock.append(code, time);
                row.appendChild(textBlock);
                if (canEdit) {
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'arn-button arn-button-danger';
                    remove.textContent = 'Remove';
                    remove.setAttribute('aria-label', 'Remove this scan from the open carton');
                    remove.addEventListener('click', async () => {
                        if (!window.confirm('Remove this scan from the open carton? The scan record will remain in audit history as removed.')) return;
                        remove.disabled = true;
                        try {
                            const result = await api('/arn/api/scan/remove', 'POST', { scanId: scan.id });
                            state = result.state;
                            renderState();
                        } catch (error) {
                            displayAlert(alert, error.message, 'error');
                            remove.disabled = false;
                        }
                    });
                    row.appendChild(remove);
                }
                list.appendChild(row);
            }
        }

        scanForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const content = scanInput.value;
            if (!content.trim() || scanButton.disabled) return;
            scanButton.disabled = true;
            try {
                const result = await api('/arn/api/scan', 'POST', { content });
                scanInput.value = '';
                state = result.state;
                renderState();
                if (result.labelPrinted) {
                    displayAlert(alert, 'Carton capacity reached. ARN label ' + result.labelReference + ' was sent automatically.', 'success');
                }
            } catch (error) {
                if (error.payload && error.payload.state) {
                    state = error.payload.state;
                    scanInput.value = '';
                    renderState();
                }
                displayAlert(alert, error.message, 'error');
            } finally {
                if (state && state.carton && state.carton.status === 'OPEN') {
                    scanButton.disabled = false;
                    scanInput.focus();
                }
            }
        });

        completeButton.addEventListener('click', async () => {
            const count = state && state.carton ? Number(state.carton.scanned_count) : 0;
            if (!count) return;
            if (!window.confirm('Seal this carton with ' + count + ' scanned units and print its ARN label? The printed QTY will be ' + count + '.')) return;
            completeButton.disabled = true;
            try {
                const result = await api('/arn/api/carton/complete', 'POST', {});
                state = result.state;
                renderState();
                displayAlert(alert, result.message + ' Reference: ' + result.labelReference, 'success');
            } catch (error) {
                if (error.payload && error.payload.state) {
                    state = error.payload.state;
                    renderState();
                }
                displayAlert(alert, error.message, 'error');
            }
        });

        retryButton.addEventListener('click', async () => {
            const historyId = state && state.carton && state.carton.label_history_id;
            const reference = state && state.printHistory && state.printHistory.label_content;
            if (!historyId) return;
            if (!window.confirm('Retry ARN reference ' + reference + '? Check the printer first: the previous send may have produced a usable label.')) return;
            retryButton.disabled = true;
            try {
                const result = await api('/arn/api/retry-label', 'POST', { printHistoryId: historyId });
                state = result.state;
                renderState();
                displayAlert(alert, 'The same ARN reference was sent again: ' + result.message, 'success');
            } catch (error) {
                if (error.payload && error.payload.state) {
                    state = error.payload.state;
                    renderState();
                }
                displayAlert(alert, error.message, 'error');
                retryButton.disabled = false;
            }
        });

        nextButton.addEventListener('click', async () => {
            nextButton.disabled = true;
            try {
                const result = await api('/arn/api/carton/next', 'POST', {});
                state = result.state;
                renderState();
                displayAlert(alert, 'Next carton opened. The MO and part remain locked to Printer ' + printer + '.', 'success');
            } catch (error) {
                displayAlert(alert, error.message, 'error');
            } finally {
                nextButton.disabled = false;
            }
        });

        unlockButton.addEventListener('click', async () => {
            if (!window.confirm('Finish this MO on Printer ' + printer + ' and clear its lock? Sealed carton and scan records will remain saved.')) return;
            unlockButton.disabled = true;
            try {
                await api('/arn/api/unlock', 'POST', {});
                window.location.assign('/arn/setup');
            } catch (error) {
                displayAlert(alert, error.message, 'error');
                unlockButton.disabled = false;
            }
        });

        try {
            await refreshState();
            if (state && !state.active) {
                document.getElementById('cartonDisplay').textContent = 'No active carton';
                scanInput.disabled = true;
                scanButton.disabled = true;
                completeButton.disabled = true;
                displayAlert(alert, 'No ARN job is locked to Printer ' + printer + '. Set up the MO and part first.', 'info');
            }
        } catch (error) {
            displayAlert(alert, error.message, 'error');
        }
    }
});
