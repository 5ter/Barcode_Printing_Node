document.addEventListener('DOMContentLoaded', () => {
    const inventory = document.getElementById('printerInventory');
    const setupMessage = document.getElementById('setupMessage');
    const drawerShell = document.getElementById('printerEditBackdrop');
    const drawer = document.getElementById('printerEditDrawer');
    const form = document.getElementById('printerEditForm');
    const saveButton = document.getElementById('savePrinterAssignment');
    const refreshButton = document.getElementById('refreshPrinters');
    const searchInput = document.getElementById('printerSearchInput');
    const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));
    const workflowRadios = Array.from(document.querySelectorAll('input[name="workflowAssignment"]'));
    const drawerError = document.getElementById('drawerError');
    const editImpact = document.getElementById('editImpact');

    let printers = [];
    let assignments = { STANDARD: null, ARN: null };
    let selectedPrinter = null;
    let activeFilter = 'all';
    let loading = false;
    let saving = false;
    let lastEditButton = null;

    function showMessage(text, kind = 'info') {
        setupMessage.textContent = text;
        setupMessage.className = 'message visible' + (kind === 'info' ? '' : ' ' + kind);
    }

    function setDrawerError(text) {
        drawerError.textContent = text;
        drawerError.hidden = !text;
    }

    function workflowForPrinter(printerId, source = assignments) {
        return Object.keys(source).find(key => source[key] === printerId) || null;
    }

    function assignedPrinterIds(source = assignments) {
        return new Set(Object.values(source).filter(Boolean));
    }

    function makeDetail(label, value, accent = false) {
        const wrapper = document.createElement('div');
        wrapper.className = 'printer-detail';
        const caption = document.createElement('span');
        caption.className = 'printer-detail-label';
        caption.textContent = label;
        const content = document.createElement('span');
        content.className = 'printer-detail-value' + (accent ? ' accent' : '');
        content.textContent = value;
        wrapper.append(caption, content);
        return wrapper;
    }

    function createPrinterCard(printer) {
        const workflowKey = workflowForPrinter(printer.id);
        const card = document.createElement('article');
        card.className = 'printer-card' + (workflowKey === 'STANDARD' ? ' assigned-standard' : '') +
            (workflowKey === 'ARN' ? ' assigned-arn' : '');

        const header = document.createElement('div');
        header.className = 'printer-card-header';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'printer-title-wrap';
        const titleLine = document.createElement('div');
        titleLine.className = 'printer-title-line';
        const title = document.createElement('h2');
        title.className = 'printer-title';
        title.textContent = printer.name || printer.id;
        const configured = document.createElement('span');
        configured.className = 'configured-badge';
        const dot = document.createElement('span');
        dot.className = 'configured-dot';
        dot.setAttribute('aria-hidden', 'true');
        configured.append(dot, document.createTextNode('Configured'));
        titleLine.append(title, configured);
        const subtitle = document.createElement('p');
        subtitle.className = 'printer-subtitle';
        subtitle.textContent = 'Printer entry defined in the application server configuration.';
        titleWrap.append(titleLine, subtitle);

        const mapping = document.createElement('div');
        mapping.className = 'pipeline-mapping';
        const mappingLabel = document.createElement('span');
        mappingLabel.className = 'pipeline-label';
        mappingLabel.textContent = 'Workflow pipeline mapping';
        const badge = document.createElement('span');
        badge.className = 'workflow-badge ' + (workflowKey === 'ARN' ? 'arn' : workflowKey === 'STANDARD' ? '' : 'unassigned');
        badge.textContent = workflowKey === 'STANDARD' ? 'Standard Product Label' :
            workflowKey === 'ARN' ? 'ARN Customer Workflow' : 'Unassigned / Standby';
        mapping.append(mappingLabel, badge);
        header.append(titleWrap, mapping);

        const details = document.createElement('div');
        details.className = 'printer-details';
        details.append(
            makeDetail('Printer ID', printer.id),
            makeDetail('Assigned workflow', workflowKey || 'UNASSIGNED', Boolean(workflowKey)),
            makeDetail('TCP port', String(printer.port || 9100))
        );

        const footer = document.createElement('div');
        footer.className = 'printer-card-footer';
        const note = document.createElement('span');
        note.className = 'config-note';
        const noteIcon = document.createElement('span');
        noteIcon.setAttribute('aria-hidden', 'true');
        noteIcon.textContent = '✓';
        note.append(noteIcon, document.createTextNode('Network settings remain server-managed'));
        const editButton = document.createElement('button');
        editButton.className = 'edit-button';
        editButton.type = 'button';
        editButton.textContent = 'Edit assignment  →';
        editButton.setAttribute('aria-label', 'Edit workflow assignment for ' + (printer.name || printer.id));
        editButton.addEventListener('click', () => openEditor(printer, editButton));
        footer.append(note, editButton);

        card.append(header, details, footer);
        return card;
    }

    function renderInventory() {
        const query = searchInput.value.trim().toLocaleLowerCase();
        const assigned = assignedPrinterIds();
        const matching = printers.filter(printer => {
            const isAssigned = assigned.has(printer.id);
            const filterMatches = activeFilter === 'all' ||
                (activeFilter === 'assigned' && isAssigned) ||
                (activeFilter === 'unassigned' && !isAssigned);
            const searchMatches = !query || [printer.name, printer.id].some(value =>
                String(value || '').toLocaleLowerCase().includes(query)
            );
            return filterMatches && searchMatches;
        });

        inventory.replaceChildren();
        if (!matching.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = printers.length ? 'No configured printers match this search/filter.' : 'No printers are configured on the application server.';
            inventory.append(empty);
            return;
        }
        matching.forEach(printer => inventory.append(createPrinterCard(printer)));
    }

    function updateSummary() {
        const assigned = assignedPrinterIds();
        document.getElementById('printerCount').textContent = String(printers.length);
        document.getElementById('assignedWorkflowCount').textContent = String(Object.values(assignments).filter(Boolean).length);
        document.getElementById('standbyPrinterCount').textContent = String(Math.max(0, printers.length - assigned.size));
        document.getElementById('unassignedWorkflowCount').textContent = String(Object.values(assignments).filter(value => !value).length);
        document.getElementById('allPrinterCount').textContent = String(printers.length);
        document.getElementById('assignedPrinterCount').textContent = String(assigned.size);
        document.getElementById('unassignedPrinterCount').textContent = String(Math.max(0, printers.length - assigned.size));

        const summary = document.getElementById('headerConfigCount');
        summary.textContent = printers.length + ' CONFIGURED PRINTER' + (printers.length === 1 ? '' : 'S');
    }

    function selectedWorkflow() {
        const checked = workflowRadios.find(radio => radio.checked);
        return checked ? checked.value : 'UNASSIGNED';
    }

    function assignmentPreview() {
        if (!selectedPrinter) return;
        const desiredWorkflow = selectedWorkflow();
        const currentWorkflow = workflowForPrinter(selectedPrinter.id);
        const pieces = [];
        if (desiredWorkflow === currentWorkflow) {
            pieces.push(desiredWorkflow === 'UNASSIGNED'
                ? 'This printer will remain unassigned.'
                : 'No routing change: this printer remains assigned to ' + (desiredWorkflow === 'ARN' ? 'ARN' : 'Standard') + '.');
        } else {
            if (currentWorkflow) {
                pieces.push(currentWorkflow + ' will become unassigned from this printer.');
            }
            if (desiredWorkflow !== 'UNASSIGNED') {
                const previousPrinterId = assignments[desiredWorkflow];
                if (previousPrinterId && previousPrinterId !== selectedPrinter.id) {
                    const previousPrinter = printers.find(printer => printer.id === previousPrinterId);
                    pieces.push((previousPrinter ? previousPrinter.name : previousPrinterId) + ' will become unassigned.');
                }
                pieces.push((desiredWorkflow === 'ARN' ? 'ARN' : 'Standard') + ' will use ' + selectedPrinter.name + '.');
            } else {
                pieces.push('This printer will be available as standby.');
            }
        }

        editImpact.textContent = pieces.join(' ');
        editImpact.className = 'edit-impact' + (desiredWorkflow !== currentWorkflow && currentWorkflow === 'ARN' ? ' warning' : '');
        saveButton.disabled = saving || loading || desiredWorkflow === currentWorkflow;
    }

    function openEditor(printer, trigger) {
        selectedPrinter = printer;
        lastEditButton = trigger;
        document.getElementById('editPrinterName').textContent = printer.name || printer.id;
        document.getElementById('editPrinterId').textContent = printer.id;
        document.getElementById('editPrinterPort').textContent = 'TCP port ' + (printer.port || 9100);
        const assignedWorkflow = workflowForPrinter(printer.id) || 'UNASSIGNED';
        workflowRadios.forEach(radio => { radio.checked = radio.value === assignedWorkflow; });
        setDrawerError('');
        assignmentPreview();
        drawerShell.hidden = false;
        document.body.classList.add('drawer-open');
        drawer.focus();
    }

    function closeEditor() {
        if (saving) return;
        drawerShell.hidden = true;
        document.body.classList.remove('drawer-open');
        selectedPrinter = null;
        if (lastEditButton && document.contains(lastEditButton)) lastEditButton.focus();
        else refreshButton.focus();
        lastEditButton = null;
    }

    async function loadAssignments() {
        if (loading) return;
        loading = true;
        refreshButton.disabled = true;
        document.getElementById('headerConfigCount').textContent = 'LOADING PRINTERS';
        try {
            const response = await fetch('/api/printer-setup/assignments', { cache: 'no-store' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.status !== 'success') {
                throw new Error(result.message || 'Could not load configured printer assignments.');
            }
            printers = Array.isArray(result.printers) ? result.printers : [];
            assignments = {
                STANDARD: result.assignments && result.assignments.STANDARD ? result.assignments.STANDARD.printerId || null : null,
                ARN: result.assignments && result.assignments.ARN ? result.assignments.ARN.printerId || null : null
            };
            updateSummary();
            renderInventory();
            showMessage('Printer inventory and workflow assignments loaded from the application database.', 'success');
            if (selectedPrinter) {
                selectedPrinter = printers.find(printer => printer.id === selectedPrinter.id) || null;
                if (selectedPrinter) assignmentPreview();
                else closeEditor();
            }
        } catch (error) {
            showMessage(error.message, 'error');
            inventory.replaceChildren();
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'Printer inventory could not be loaded. Check the database migration and try refreshing.';
            inventory.append(empty);
        } finally {
            loading = false;
            refreshButton.disabled = false;
            if (selectedPrinter) assignmentPreview();
        }
    }

    workflowRadios.forEach(radio => radio.addEventListener('change', assignmentPreview));
    searchInput.addEventListener('input', renderInventory);
    filterButtons.forEach(button => button.addEventListener('click', () => {
        activeFilter = button.dataset.filter;
        filterButtons.forEach(item => {
            const selected = item === button;
            item.classList.toggle('selected', selected);
            item.setAttribute('aria-pressed', String(selected));
        });
        renderInventory();
    }));

    document.getElementById('closeDrawer').addEventListener('click', closeEditor);
    document.getElementById('cancelEdit').addEventListener('click', closeEditor);
    document.getElementById('drawerBackdrop').addEventListener('click', closeEditor);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !drawerShell.hidden) closeEditor();
        if (event.key === 'Tab' && !drawerShell.hidden) {
            const focusable = Array.from(drawer.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
    refreshButton.addEventListener('click', loadAssignments);

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (saving || !selectedPrinter) return;
        const workflowKey = selectedWorkflow();
        const currentWorkflow = workflowForPrinter(selectedPrinter.id);
        if (workflowKey === currentWorkflow) return;

        saving = true;
        saveButton.textContent = 'Saving assignment…';
        saveButton.disabled = true;
        setDrawerError('');
        try {
            const response = await fetch('/api/printer-setup/assignments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ printerId: selectedPrinter.id, workflowKey })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.status !== 'success') {
                throw new Error(result.message || 'Could not save this printer assignment.');
            }
            assignments = {
                STANDARD: result.assignments.STANDARD.printerId || null,
                ARN: result.assignments.ARN.printerId || null
            };
            updateSummary();
            renderInventory();
            showMessage('Printer assignment saved. The previous workflow/printer is now unassigned as shown in the inventory.', 'success');
            saving = false;
            closeEditor();
        } catch (error) {
            setDrawerError(error.message);
        } finally {
            saving = false;
            saveButton.textContent = 'Save Assignment';
            if (selectedPrinter) assignmentPreview();
        }
    });

    loadAssignments();
});
