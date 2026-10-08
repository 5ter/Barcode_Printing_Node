document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const printerId = urlParams.get('Printer');
    const message = document.getElementById('message');
    const tabs = Array.from(document.querySelectorAll('[data-label-tab]'));
    const panels = {
        standard: document.getElementById('standardPanel'),
        arn: document.getElementById('arnPanel')
    };

    function focusNextInput(form) {
        const mo = form.elements.MO;
        const partNumber = form.elements.ActID || form.elements.ManufacturerPartNo;

        if (mo && !mo.value) {
            mo.focus();
        } else if (partNumber && !partNumber.value) {
            partNumber.focus();
        }
    }

    function showTab(mode) {
        for (const tab of tabs) {
            const isSelected = tab.dataset.labelTab === mode;
            tab.classList.toggle('active', isSelected);
            tab.setAttribute('aria-selected', String(isSelected));
        }

        for (const [panelMode, panel] of Object.entries(panels)) {
            panel.hidden = panelMode !== mode;
        }

        focusNextInput(document.getElementById(mode === 'arn' ? 'arnForm' : 'dataForm'));
    }

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => showTab(tab.dataset.labelTab));
    });

    const standardForm = document.getElementById('dataForm');
    const arnForm = document.getElementById('arnForm');
    const retryArnButton = document.getElementById('retryArnPrint');
    let retryableArnJob = null;

    function clearArnRetry() {
        retryableArnJob = null;
        retryArnButton.hidden = true;
        retryArnButton.disabled = false;
    }

    function exposeArnRetry(printHistoryId, reference) {
        if (!printHistoryId) return;
        retryableArnJob = {
            printHistoryId: String(printHistoryId),
            reference: String(reference || 'unknown')
        };
        retryArnButton.hidden = false;
    }

    [standardForm, arnForm].forEach((form) => {
        const mo = form.elements.MO;
        const partNumber = form.elements.ActID || form.elements.ManufacturerPartNo;
        mo.addEventListener('change', () => focusNextInput(form));
        partNumber.addEventListener('change', () => focusNextInput(form));
    });

    async function submitPrint(form, mode) {
        const resultDisplay = mode === 'ARN'
            ? form.elements.ARNPartNoDisplay
            : form.elements.CustID;
        const submitButton = form.querySelector('button[type="submit"]');

        if (!form.checkValidity()) {
            form.classList.add('was-validated');
            focusNextInput(form);
            return;
        }

        if (mode === 'ARN') clearArnRetry();

        const payload = {
            MO: form.elements.MO.value,
            printerUrl_id: printerId,
            labelMode: mode
        };

        if (mode === 'ARN') {
            payload.ManufacturerPartNo = form.elements.ManufacturerPartNo.value;
        } else {
            payload.ActID = form.elements.ActID.value;
        }

        resultDisplay.value = 'Processing request... Please wait.';
        message.textContent = 'Sending ' + (mode === 'ARN' ? 'ARN ' : '') +
            'print request (Printer: ' + (printerId || 'Default') + ')...';
        form.classList.remove('was-validated');
        submitButton.disabled = true;

        try {
            const response = await fetch('/submit-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (mode === 'ARN' && data.retryAvailable) {
                    exposeArnRetry(data.printHistoryId, data.labelReference || data.message);
                }
                throw new Error(data.message || 'Request failed with status ' + response.status);
            }

            resultDisplay.value = mode === 'ARN'
                ? (data.arnPartNo || 'N/A')
                : (data.customerID || 'N/A');
            const serial = Array.isArray(data.newSerial) ? data.newSerial.join(', ') : data.newSerial;
            if (mode === 'ARN') {
                exposeArnRetry(data.printHistoryId, data.message);
                message.textContent = 'ARN label data sent to the printer. Inspect the physical label. MO: ' + data.mo +
                    '; Qty on label: ' + data.quantity +
                    '; PO: ' + data.purchaseOrder +
                    '; Mfr Ref: ' + data.message +
                    '. If missing or defective after correcting the printer, use Retry same ARN reference.';
            } else {
                message.textContent = 'Print job successful. Serial: ' + serial +
                    '. Generated label: ' + data.message;
            }
        } catch (error) {
            console.error('Print request failed:', error);
            resultDisplay.value = 'FAILED';
            message.textContent = 'Error: ' + error.message +
                (retryableArnJob ? ' A same-reference retry is available for ' + retryableArnJob.reference + '.' : '');
        } finally {
            submitButton.disabled = false;
        }
    }

    standardForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitPrint(standardForm, 'STANDARD');
    });

    arnForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitPrint(arnForm, 'ARN');
    });

    retryArnButton.addEventListener('click', async () => {
        if (!retryableArnJob) return;

        const job = retryableArnJob;
        const confirmed = window.confirm(
            'Resend ARN reference ' + job.reference + ' to the original printer? This does not create a new reference, but can produce a duplicate label if the earlier label is usable.'
        );
        if (!confirmed) return;

        retryArnButton.disabled = true;
        message.textContent = 'Retrying ARN reference ' + job.reference + ' with the same saved printer payload...';
        try {
            const response = await fetch('/retry-arn-print', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ printHistoryId: job.printHistoryId })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.message || 'Retry failed with status ' + response.status);
            }

            arnForm.elements.ARNPartNoDisplay.value = data.arnPartNo || 'N/A';
            message.textContent = 'The same ARN reference was sent again: ' + data.message + '. Inspect the physical label.';
        } catch (error) {
            console.error('ARN retry failed:', error);
            message.textContent = 'Retry did not complete for ' + job.reference + ': ' + error.message +
                '. The retry button remains available; no new reference was allocated.';
        } finally {
            retryArnButton.disabled = false;
        }
    });

    showTab('standard');
});
