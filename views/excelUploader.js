document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const dropZone = document.getElementById('dropZone');
    const replaceButton = document.getElementById('replaceBtn');
    const submitButton = document.getElementById('submitImportBtn');
    const toast = document.getElementById('toastNotification');
    const closeToastButton = document.getElementById('closeToast');

    if (!fileInput || !fileNameDisplay || !submitButton) return;

    const requestedMainPort = Number(document.body.dataset.mainAppPort);
    const mainAppPort = Number.isInteger(requestedMainPort) && requestedMainPort > 0 && requestedMainPort <= 65535
        ? String(requestedMainPort)
        : '3003';

    function mainAppUrl(pathname) {
        const url = new URL(window.location.href);
        url.port = mainAppPort;
        url.pathname = pathname;
        url.search = '';
        url.hash = '';
        return url.toString();
    }

    const scanLink = document.querySelector('[data-path="scan-trace"]');
    const labelLink = document.querySelector('[data-path="label-printing"]');
    const uploadLink = document.querySelector('[data-path="upload-excel"]');
    const dashboardLink = document.querySelector('[data-path="dashboard"]');
    if (scanLink) scanLink.href = mainAppUrl('/arn/setup');
    if (labelLink) labelLink.href = mainAppUrl('/standard');
    if (uploadLink) uploadLink.href = '/';
    if (dashboardLink) dashboardLink.href = mainAppUrl('/dashboard');

    // These routes are not implemented in this app yet.
    document.querySelectorAll('[data-path="audit-log"], [data-path="settings"]')
        .forEach(link => { link.hidden = true; });
    document.querySelector('a[href="#history-section"]')?.setAttribute('hidden', '');
    document.getElementById('history-section')?.setAttribute('hidden', '');

    // Manual registration and the history panel in the supplied mockup are not
    // backed by server endpoints. Keep the screen focused on real workbook import.
    document.getElementById('modeManualBtn')?.setAttribute('hidden', '');
    document.getElementById('manualEntrySection')?.setAttribute('hidden', '');
    const terminalDescription = document.querySelector('#modeBulkBtn')?.parentElement?.parentElement
        ?.parentElement?.querySelector('p');
    if (terminalDescription) terminalDescription.textContent = 'Import a Standard or ARN workbook using the existing validated database importer.';

    // Remove design-time sample identity/status so it is not mistaken for login
    // or a live operator-station indicator.
    const mockOperator = Array.from(document.querySelectorAll('header span'))
        .find(element => element.textContent.includes('Line 6 Operator'));
    if (mockOperator && mockOperator.parentElement && mockOperator.parentElement.parentElement) {
        mockOperator.parentElement.parentElement.remove();
    }
    document.querySelector('a[data-path="settings"]')?.parentElement?.remove();

    const downloadButton = document.getElementById('downloadTemplateBtn');
    const templateMenu = document.getElementById('templateMenu');
    const templateLinks = templateMenu ? Array.from(templateMenu.querySelectorAll('a')) : [];
    if (templateLinks[0]) templateLinks[0].href = '/templates/standard';
    if (templateLinks[1]) templateLinks[1].href = '/templates/arn';
    downloadButton?.addEventListener('click', event => {
        event.stopPropagation();
        templateMenu?.classList.toggle('hidden');
    });
    document.addEventListener('click', () => templateMenu?.classList.add('hidden'));

    const stagedPanel = fileNameDisplay.parentElement?.parentElement?.parentElement;
    const stagedStatus = stagedPanel?.querySelector('.bg-tertiary-fixed');
    const fileDetails = fileNameDisplay.parentElement?.nextElementSibling;
    const progressInfo = stagedPanel?.querySelector('.pt-1');
    const progressLabels = progressInfo ? progressInfo.querySelectorAll('span') : [];
    const progressBar = progressInfo?.querySelector('.w-full.bg-surface-container-high > div');

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderSelectedFile(file) {
        fileNameDisplay.textContent = file ? file.name : 'No workbook selected';
        if (fileDetails) {
            fileDetails.textContent = file
                ? formatBytes(file.size) + ' - Headers will be validated during import.'
                : 'Choose a Standard or ARN workbook to begin.';
        }
        if (stagedStatus) stagedStatus.textContent = file ? 'Ready to import' : 'Waiting for workbook';
        if (progressLabels[0]) progressLabels[0].textContent = file
            ? 'The importer detects and validates the workbook schema on upload.'
            : 'No workbook selected.';
        if (progressLabels[1]) progressLabels[1].textContent = file ? 'Ready' : 'Waiting';
        if (progressBar) progressBar.style.width = file ? '100%' : '0%';
        submitButton.disabled = !file;
    }

    renderSelectedFile(fileInput.files[0] || null);
    fileInput.addEventListener('change', () => renderSelectedFile(fileInput.files[0] || null));

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone?.addEventListener(eventName, event => {
            event.preventDefault();
            dropZone.classList.add('bg-primary-fixed/20');
        });
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone?.addEventListener(eventName, event => {
            event.preventDefault();
            dropZone.classList.remove('bg-primary-fixed/20');
            if (event.type === 'drop' && event.dataTransfer?.files?.length) {
                const transfer = new DataTransfer();
                transfer.items.add(event.dataTransfer.files[0]);
                fileInput.files = transfer.files;
                renderSelectedFile(fileInput.files[0]);
            }
        });
    });

    replaceButton?.addEventListener('click', () => {
        fileInput.value = '';
        renderSelectedFile(null);
    });

    function showError(message) {
        if (!toast) {
            window.alert(message);
            return;
        }
        const text = document.createElement('span');
        text.textContent = message;
        if (closeToastButton) toast.replaceChildren(text, closeToastButton);
        else toast.replaceChildren(text);
        toast.classList.remove('hidden');
        toast.classList.add('border-error');
    }

    closeToastButton?.addEventListener('click', () => toast?.classList.add('hidden'));

    submitButton.addEventListener('click', async () => {
        const file = fileInput.files[0];
        if (!file) {
            showError('Choose an Excel workbook before importing.');
            return;
        }

        const originalButtonHtml = submitButton.innerHTML;
        submitButton.disabled = true;
        submitButton.textContent = 'Uploading and validating workbook…';

        const formData = new FormData();
        formData.append('excelFile', file);
        try {
            const response = await fetch('/upload', { method: 'POST', body: formData });
            const resultHtml = await response.text();
            // The established upload route returns its success/error result page.
            // Render it directly instead of showing the mock success notification.
            document.open();
            document.write(resultHtml);
            document.close();
        } catch (error) {
            submitButton.innerHTML = originalButtonHtml;
            renderSelectedFile(file);
            showError('The upload request could not reach the Excel service. ' + error.message);
        }
    });

    // Remove inaccurate prototype-only statements from the visible UI.
    document.querySelectorAll('body *').forEach(element => {
        if (element.children.length !== 0) return;
        const text = element.textContent.trim();
        if (text.includes('PostgreSQL Partition:')) element.textContent = 'Configured MySQL schema: bcps_label';
        if (text.includes('ACTMAX-PG-CLUSTER-01')) element.textContent = 'Standard / ARN workbook import';
        if (text.includes('Live Cache Invalidation')) element.textContent = 'Standard and ARN schema validation';
        if (text.includes('validated upon drop')) element.textContent = 'Workbook headers are validated during import';
        if (text.includes('or enter single records manually')) element.textContent = 'Upload either a Standard workbook or an ARN workbook. The backend detects the schema and validates headers before writing.';
    });
    document.querySelectorAll('p').forEach(paragraph => {
        if (paragraph.textContent.includes('or enter single records manually')) {
            paragraph.textContent = 'Upload either a Standard workbook or an ARN workbook. The backend detects the schema and validates headers before writing.';
        }
    });
    const schemaTarget = Array.from(document.querySelectorAll('span'))
        .find(element => element.textContent.includes('PostgreSQL Partition:'));
    if (schemaTarget) schemaTarget.textContent = 'MySQL schema: bcps_label';
    const schemaBadge = Array.from(document.querySelectorAll('span'))
        .find(element => element.textContent.trim() === 'Ready' &&
            element.previousElementSibling?.textContent.includes('MySQL schema: bcps_label'));
    if (schemaBadge) schemaBadge.textContent = 'Configured';
});
