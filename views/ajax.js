document.addEventListener('DOMContentLoaded', () => {
    const message = document.getElementById('message');
    const standardForm = document.getElementById('dataForm');
    const workflowHomeLink = document.getElementById('workflowHomeLink');
    const assignedPrinterLabel = document.getElementById('assignedPrinterLabel');
    const submitButton = standardForm.querySelector('button[type="submit"]');
    let assignedPrinter = null;
    submitButton.disabled = true;
    if (workflowHomeLink) workflowHomeLink.href = '/';

    fetch('/api/workflow-printers', { cache: 'no-store' })
        .then(response => response.json().then(data => ({ response, data })))
        .then(({ response, data }) => {
            if (!response.ok || data.status !== 'success' || !data.assignments.STANDARD.printerId) {
                throw new Error(data.message || 'No printer is assigned to the Standard workflow.');
            }
            assignedPrinter = data.assignments.STANDARD;
            assignedPrinterLabel.textContent = 'Printer ' + assignedPrinter.printerLetter + ' — ' + assignedPrinter.printerName;
            submitButton.disabled = false;
            message.textContent = 'Enter the MO and Actmax Part No. The Standard workflow is assigned to Printer ' + assignedPrinter.printerLetter + '.';
        })
        .catch(error => {
            assignedPrinterLabel.textContent = 'Assignment unavailable';
            message.textContent = error.message + ' Open Printer Setup or contact the application administrator.';
        });
    function focusNextInput() {
        const mo = standardForm.elements.MO;
        const partNumber = standardForm.elements.ActID;
        if (mo && !mo.value) mo.focus();
        else if (partNumber && !partNumber.value) partNumber.focus();
    }

    const moInput = standardForm.elements.MO;
    const partNumberInput = standardForm.elements.ActID;
    moInput.addEventListener('change', focusNextInput);
    partNumberInput.addEventListener('change', focusNextInput);

    standardForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!standardForm.checkValidity()) {
            standardForm.classList.add('was-validated');
            focusNextInput();
            return;
        }

        const customerPartDisplay = standardForm.elements.CustID;
        customerPartDisplay.value = 'Processing request... Please wait.';
        message.textContent = 'Sending Standard print request to Printer ' + assignedPrinter.printerLetter + '...';
        standardForm.classList.remove('was-validated');
        submitButton.disabled = true;

        try {
            const response = await fetch('/submit-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    MO: moInput.value,
                    ActID: partNumberInput.value,
                    labelMode: 'STANDARD'
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.message || 'Request failed with status ' + response.status);
            }

            customerPartDisplay.value = data.customerID || 'N/A';
            const serial = Array.isArray(data.newSerial) ? data.newSerial.join(', ') : data.newSerial;
            message.textContent = 'Print job successful. Serial: ' + serial +
                '. Generated label: ' + data.message;
        } catch (error) {
            console.error('Standard print request failed:', error);
            customerPartDisplay.value = 'FAILED';
            message.textContent = 'Error: ' + error.message;
        } finally {
            submitButton.disabled = false;
        }
    });

    focusNextInput();
});
