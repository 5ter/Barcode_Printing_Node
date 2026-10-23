document.addEventListener('DOMContentLoaded', () => {
    const standardSelect = document.getElementById('standardPrinter');
    const arnSelect = document.getElementById('arnPrinter');
    const saveButton = document.getElementById('saveAssignments');
    const message = document.getElementById('setupMessage');
    const errorBox = document.getElementById('assignmentError');
    let printers = [];
    let saving = false;

    function showMessage(text, kind = 'info') {
        message.textContent = text;
        message.className = 'message visible' + (kind === 'info' ? '' : ' ' + kind);
    }

    function displayAssignmentError(text) {
        errorBox.textContent = text;
        errorBox.hidden = false;
    }

    function clearAssignmentError() {
        errorBox.textContent = '';
        errorBox.hidden = true;
    }

    function addPrinterOptions(select, selectedId) {
        select.replaceChildren();
        const unassignedOption = document.createElement('option');
        unassignedOption.value = '';
        unassignedOption.textContent = 'Unassigned';
        select.append(unassignedOption);
        for (const printer of printers) {
            const option = document.createElement('option');
            option.value = printer.id;
            option.textContent = printer.letter + ' — ' + printer.name;
            select.append(option);
        }
        select.value = selectedId || '';
        select.disabled = false;
    }

    function currentAssignments() {
        return {
            standardPrinterId: standardSelect.value,
            arnPrinterId: arnSelect.value
        };
    }

    function renderPrinterList(assignments) {
        const list = document.getElementById('printerList');
        const standardPrinterId = typeof assignments.STANDARD === 'string'
            ? assignments.STANDARD
            : assignments.STANDARD.printerId;
        const arnPrinterId = typeof assignments.ARN === 'string'
            ? assignments.ARN
            : assignments.ARN.printerId;
        const assignedWorkflow = new Map();
        if (standardPrinterId) assignedWorkflow.set(standardPrinterId, 'STANDARD');
        if (arnPrinterId) assignedWorkflow.set(arnPrinterId, 'ARN');
        list.replaceChildren();

        for (const printer of printers) {
            const item = document.createElement('article');
            item.className = 'printer-item';
            const identity = document.createElement('div');
            identity.className = 'printer-identity';
            const name = document.createElement('span');
            name.className = 'printer-name';
            name.textContent = printer.name;
            const id = document.createElement('span');
            id.className = 'printer-id';
            id.textContent = printer.id;
            identity.append(name, id);

            const workflow = document.createElement('span');
            const assignedTo = assignedWorkflow.get(printer.id);
            workflow.className = 'printer-workflow' + (assignedTo ? ' assigned' : '');
            workflow.textContent = assignedTo || 'UNASSIGNED';
            item.append(identity, workflow);
            list.append(item);
        }
    }

    function updateSummary() {
        const { standardPrinterId, arnPrinterId } = currentAssignments();
        const hasConflict = Boolean(standardPrinterId && standardPrinterId === arnPrinterId);
        const assignedCount = [standardPrinterId, arnPrinterId].filter(Boolean).length;
        document.getElementById('workflowCount').textContent = String(assignedCount);
        document.getElementById('availableCount').textContent = String(
            Math.max(0, printers.length - new Set([standardPrinterId, arnPrinterId].filter(Boolean)).size)
        );
        saveButton.disabled = saving || hasConflict;
        if (hasConflict) {
            displayAssignmentError('The same printer cannot be assigned to both workflows.');
        } else {
            clearAssignmentError();
        }
    }

    function previewCurrentAssignments() {
        const { standardPrinterId, arnPrinterId } = currentAssignments();
        renderPrinterList({
            STANDARD: { printerId: standardPrinterId || null },
            ARN: { printerId: arnPrinterId || null }
        });
    }

    function handleAssignmentChange(changedSelect, otherSelect, workflowName) {
        if (changedSelect.value && changedSelect.value === otherSelect.value) {
            const selectedOption = changedSelect.options[changedSelect.selectedIndex];
            const printerName = selectedOption ? selectedOption.textContent : changedSelect.value;
            otherSelect.value = '';
            showMessage(printerName + ' moved to ' + workflowName + '; the other workflow is now Unassigned. Save to apply.', 'info');
        }
        previewCurrentAssignments();
        updateSummary();
    }

    async function loadAssignments() {
        try {
            const response = await fetch('/api/printer-setup/assignments', { cache: 'no-store' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.status !== 'success') {
                throw new Error(result.message || 'Could not load workflow printer assignments.');
            }

            printers = result.printers || [];
            document.getElementById('printerCount').textContent = String(printers.length);
            addPrinterOptions(standardSelect, result.assignments.STANDARD.printerId);
            addPrinterOptions(arnSelect, result.assignments.ARN.printerId);
            renderPrinterList(result.assignments);
            showMessage('Assignments loaded from the application database.', 'success');
            updateSummary();
        } catch (error) {
            showMessage(error.message, 'error');
            standardSelect.disabled = true;
            arnSelect.disabled = true;
            saveButton.disabled = true;
        }
    }

    standardSelect.addEventListener('change', () => handleAssignmentChange(standardSelect, arnSelect, 'Standard'));
    arnSelect.addEventListener('change', () => handleAssignmentChange(arnSelect, standardSelect, 'ARN'));
    saveButton.addEventListener('click', async () => {
        if (saving) return;
        const payload = currentAssignments();
        if (payload.standardPrinterId && payload.standardPrinterId === payload.arnPrinterId) {
            updateSummary();
            return;
        }

        saving = true;
        saveButton.textContent = 'Saving assignments…';
        updateSummary();
        try {
            const response = await fetch('/api/printer-setup/assignments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.status !== 'success') {
                throw new Error(result.message || 'Could not save workflow printer assignments.');
            }

            renderPrinterList(result.assignments);
            showMessage('Workflow assignments saved. New print activity will use the updated routing.', 'success');
        } catch (error) {
            showMessage(error.message, 'error');
        } finally {
            saving = false;
            saveButton.textContent = 'Save Workflow Assignments';
            updateSummary();
        }
    });

    loadAssignments();
});
