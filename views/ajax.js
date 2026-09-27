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
        const actId = form.elements.ActID;

        if (mo && !mo.value) {
            mo.focus();
        } else if (actId && !actId.value) {
            actId.focus();
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

    [standardForm, arnForm].forEach((form) => {
        const mo = form.elements.MO;
        const actId = form.elements.ActID;
        mo.addEventListener('change', () => focusNextInput(form));
        actId.addEventListener('change', () => focusNextInput(form));
    });

    async function submitPrint(form, mode) {
        const customerDisplay = form.elements.CustID;
        const submitButton = form.querySelector('button[type="submit"]');

        if (!form.checkValidity()) {
            form.classList.add('was-validated');
            focusNextInput(form);
            return;
        }

        const payload = {
            MO: form.elements.MO.value,
            ActID: form.elements.ActID.value,
            printerUrl_id: printerId,
            labelMode: mode
        };

        if (mode === 'ARN') {
            payload.quantity = form.elements.quantity.value;
            payload.PO = form.elements.PO.value;
        }

        customerDisplay.value = 'Processing request... Please wait.';
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
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || 'Request failed with status ' + response.status);
            }

            customerDisplay.value = data.customerID || 'N/A';
            const serial = Array.isArray(data.newSerial) ? data.newSerial.join(', ') : data.newSerial;
            message.textContent = 'Print job successful. Serial: ' + serial +
                '. Generated label: ' + data.message;
        } catch (error) {
            console.error('Print request failed:', error);
            customerDisplay.value = 'FAILED';
            message.textContent = 'Error: ' + error.message;
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

    showTab('standard');
});
