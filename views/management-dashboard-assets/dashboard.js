(() => {
  const form = document.getElementById('filter-form');
  const startInput = document.getElementById('start-date');
  const endInput = document.getElementById('end-date');
  const pageSizeInput = document.getElementById('page-size');
  const tableHead = document.getElementById('table-head');
  const tableBody = document.getElementById('table-body');
  const notice = document.getElementById('notice');
  const refreshButton = document.getElementById('refresh-button');
  const exportExcelButton = document.getElementById('export-excel-button');
  const exportCsvButton = document.getElementById('export-csv-button');
  const previousButton = document.getElementById('previous-page');
  const nextButton = document.getElementById('next-page');
  const tabButtons = [...document.querySelectorAll('.view-tab')];

  let activeFilters;
  let requestNumber = 0;
  let noticeTimer;

  function localDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function displayDate(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
    if (!Number.isFinite(date.getTime())) return escapeHtml(value);
    return new Intl.DateTimeFormat(undefined, {
      year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(date);
  }

  function number(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
  }

  function showNotice(message, success = false) {
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.classList.toggle('success', success);
    notice.hidden = false;
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
  }

  function queryString(filters) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '' && value !== null && value !== undefined) params.set(key, value);
    }
    return params;
  }

  function setLoading(loading) {
    document.getElementById('table-scroll').classList.toggle('loading', loading);
    refreshButton.disabled = loading;
    exportExcelButton.disabled = loading;
    exportCsvButton.disabled = loading;
    refreshButton.querySelector('span').textContent = loading ? 'Loading…' : 'Refresh';
  }

  function statusTag(value) {
    const normalized = String(value || 'UNKNOWN').toLowerCase().replace(/[^a-z-]/g, '-');
    return `<span class="status-tag status-${escapeHtml(normalized)}">${escapeHtml(value || 'UNKNOWN')}</span>`;
  }

  function renderSummary(summary) {
    document.getElementById('stat-cartons').textContent = number(summary.cartonLabels);
    document.getElementById('stat-cartons-sent').textContent = number(summary.cartonLabelsSent);
    document.getElementById('stat-standard').textContent = number(summary.standardLabels);
    document.getElementById('stat-scans').textContent = number(summary.arnUnitScans);
    document.getElementById('stat-failed').textContent = number(summary.cartonPrintFailures);
    document.getElementById('tab-carton-count').textContent = number(summary.cartonLabels);
    document.getElementById('tab-product-count').textContent = number(summary.productRecords);
  }

  function renderCartons(rows) {
    tableHead.innerHTML = `<tr>
      <th>Details</th><th>ARN carton label</th><th>MO</th><th>Part / Manufacturer PN</th>
      <th>PO</th><th>Scanned / Capacity</th><th>Print status</th><th>Printer</th><th>Printed at</th>
    </tr>`;
    if (!rows.length) {
      tableBody.innerHTML = '<tr><td class="empty-state" colspan="9">No ARN carton label records match these filters.</td></tr>';
      return;
    }

    tableBody.innerHTML = rows.map(row => {
      const cartonId = row.cartonId ? String(row.cartonId) : '';
      const canExpand = Boolean(cartonId);
      const capacity = row.boxCapacity || row.labelQuantity || '—';
      const scanned = Number(row.scannedCount || row.activeScanCount || 0);
      const cartonStatus = row.cartonStatus ? ` <span class="muted">· ${escapeHtml(row.cartonStatus)}</span>` : '';
      return `<tr class="data-row">
        <td><button class="expand-button" type="button" data-carton-id="${escapeHtml(cartonId)}" aria-expanded="false" ${canExpand ? '' : 'disabled'} title="${canExpand ? 'Show scanned product labels' : 'No carton scan record is linked'}">›</button></td>
        <td><span class="code link-code">${escapeHtml(row.labelReference || '—')}</span><div class="minor">${cartonId ? `Carton #${escapeHtml(cartonId)}` : 'Historical label without scan link'}</div></td>
        <td class="code">${escapeHtml(row.mo || '—')}</td>
        <td><span class="code">${escapeHtml(row.arnPartNo || '—')}</span><div class="minor">Mfr: ${escapeHtml(row.manufacturerPartNo || '—')}</div></td>
        <td class="code">${escapeHtml(row.purchaseOrder || '—')}</td>
        <td><span class="code">${number(scanned)} / ${escapeHtml(capacity)}</span>${cartonStatus}</td>
        <td>${statusTag(row.printStatus)}</td>
        <td class="code">${escapeHtml(row.printerId || '—')}</td>
        <td>${displayDate(row.printedAt)}<div class="minor">YYWW ${escapeHtml(row.dateCode || '—')} · Ref ${escapeHtml(row.itemNo || '—')}</div></td>
      </tr>`;
    }).join('');
  }

  function renderProducts(rows) {
    tableHead.innerHTML = `<tr>
      <th>Record type</th><th>Label / scanned product content</th><th>MO</th><th>Part number</th>
      <th>Customer / manufacturer detail</th><th>Carton</th><th>Status</th><th>Printer</th><th>Date &amp; time</th>
    </tr>`;
    if (!rows.length) {
      tableBody.innerHTML = '<tr><td class="empty-state" colspan="9">No product-label or ARN scan records match these filters.</td></tr>';
      return;
    }

    tableBody.innerHTML = rows.map(row => {
      const details = row.recordType === 'STANDARD LABEL'
        ? `Customer PN: ${escapeHtml(row.customerPartNo || '—')}${row.serialNo ? ` · Serial ${escapeHtml(row.serialNo)}` : ''}`
        : `Manufacturer PN: ${escapeHtml(row.manufacturerPartNo || '—')}${row.purchaseOrder ? ` · PO ${escapeHtml(row.purchaseOrder)}` : ''}`;
      const carton = row.cartonId
        ? `<span class="code">#${escapeHtml(row.cartonId)}</span><div class="minor">${escapeHtml(row.cartonLabelReference || 'label not printed yet')}</div>`
        : '—';
      return `<tr class="data-row">
        <td><span class="mode-tag">${escapeHtml(row.recordType)}</span></td>
        <td><span class="code link-code">${escapeHtml(row.labelContent || '—')}</span></td>
        <td class="code">${escapeHtml(row.mo || '—')}</td>
        <td class="code">${escapeHtml(row.partNo || '—')}</td>
        <td>${details}</td>
        <td>${carton}</td>
        <td>${statusTag(row.recordStatus)}</td>
        <td class="code">${escapeHtml(row.printerId || '—')}</td>
        <td>${displayDate(row.eventAt)}</td>
      </tr>`;
    }).join('');
  }

  function renderPagination(pagination) {
    const start = pagination.total ? ((pagination.page - 1) * pagination.pageSize) + 1 : 0;
    const end = Math.min(pagination.page * pagination.pageSize, pagination.total);
    document.getElementById('result-range').textContent = `Showing ${number(start)}–${number(end)} of ${number(pagination.total)} records`;
    document.getElementById('page-label').textContent = `Page ${number(pagination.page)} of ${number(Math.max(1, pagination.totalPages))}`;
    previousButton.disabled = pagination.page <= 1;
    nextButton.disabled = pagination.page >= pagination.totalPages;
  }

  async function loadDashboard() {
    const currentRequest = ++requestNumber;
    const params = queryString(activeFilters);
    setLoading(true);
    try {
      const response = await fetch(`/api/management-dashboard?${params}`, { headers: { Accept: 'application/json' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Could not load the dashboard.');
      if (currentRequest !== requestNumber) return;

      renderSummary(result.summary);
      if (activeFilters.view === 'cartons') renderCartons(result.rows);
      else renderProducts(result.rows);
      renderPagination(result.pagination);
      document.getElementById('last-updated').textContent = `Updated ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
      tabButtons.forEach(button => {
        const selected = button.dataset.view === activeFilters.view;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', String(selected));
      });
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      tableHead.innerHTML = '';
      tableBody.innerHTML = `<tr><td class="empty-state" colspan="9">${escapeHtml(error.message)}</td></tr>`;
      document.getElementById('result-range').textContent = 'Unable to load records';
      showNotice(error.message);
    } finally {
      if (currentRequest === requestNumber) setLoading(false);
    }
  }

  async function showCartonScans(button) {
    const cartonId = button.dataset.cartonId;
    if (!cartonId) return;
    const currentRow = button.closest('tr');
    const existingDetails = currentRow.nextElementSibling;
    if (existingDetails && existingDetails.dataset.cartonDetail === cartonId) {
      existingDetails.remove();
      button.setAttribute('aria-expanded', 'false');
      button.textContent = '›';
      return;
    }

    if (existingDetails && existingDetails.classList.contains('detail-row')) existingDetails.remove();
    button.setAttribute('aria-expanded', 'true');
    button.textContent = '⌄';
    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row';
    detailRow.dataset.cartonDetail = cartonId;
    detailRow.innerHTML = '<td colspan="9"><div class="detail-panel">Loading product scans…</div></td>';
    currentRow.after(detailRow);

    try {
      const response = await fetch(`/api/management-dashboard/cartons/${encodeURIComponent(cartonId)}/scans`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Could not load carton contents.');
      const active = result.rows.filter(scan => !scan.removedAt).length;
      const removed = result.rows.length - active;
      const items = result.rows.length
        ? `<div class="scan-list">${result.rows.map((scan, index) => `<div class="scan-item">
            <span class="code">#${String(index + 1).padStart(2, '0')} ${escapeHtml(scan.scannedContent)}</span>
            ${scan.removedAt ? '<span class="status-tag status-removed">REMOVED</span>' : '<span class="status-tag status-in-carton">IN CARTON</span>'}
            <span class="scan-time">${displayDate(scan.removedAt || scan.scannedAt)}</span>
          </div>`).join('')}</div>`
        : '<p class="filter-help">No product scans are stored for this carton.</p>';
      detailRow.querySelector('.detail-panel').innerHTML = `<div class="detail-header"><strong>Product label scans · ${number(active)} currently in carton</strong><span>${number(removed)} removed scan${removed === 1 ? '' : 's'} retained in audit history</span></div>${items}`;
    } catch (error) {
      detailRow.querySelector('.detail-panel').textContent = error.message;
      showNotice(error.message);
    }
  }

  function collectFormFilters() {
    return {
      startDate: startInput.value,
      endDate: endInput.value,
      mo: document.getElementById('mo-filter').value.trim(),
      part: document.getElementById('part-filter').value.trim(),
      printer: document.getElementById('printer-filter').value,
      search: document.getElementById('search-filter').value.trim(),
      view: activeFilters.view,
      page: 1,
      pageSize: Number(pageSizeInput.value)
    };
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    activeFilters = collectFormFilters();
    loadDashboard();
  });

  document.getElementById('reset-button').addEventListener('click', () => {
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 29);
    startInput.value = localDate(thirtyDaysAgo);
    endInput.value = localDate(today);
    document.getElementById('mo-filter').value = '';
    document.getElementById('part-filter').value = '';
    document.getElementById('printer-filter').value = '';
    document.getElementById('search-filter').value = '';
    activeFilters = collectFormFilters();
    loadDashboard();
  });

  tabButtons.forEach(button => button.addEventListener('click', () => {
    if (activeFilters.view === button.dataset.view) return;
    activeFilters.view = button.dataset.view;
    activeFilters.page = 1;
    loadDashboard();
  }));

  tableBody.addEventListener('click', event => {
    const button = event.target.closest('.expand-button');
    if (button) showCartonScans(button);
  });
  refreshButton.addEventListener('click', loadDashboard);
  function exportRecords(format) {
    const params = queryString(activeFilters);
    params.set('format', format);
    window.location.assign(`/api/management-dashboard/export?${params}`);
    showNotice(`Export started for all filtered ${activeFilters.view} records.`, true);
  }
  exportExcelButton.addEventListener('click', () => exportRecords('xlsx'));
  exportCsvButton.addEventListener('click', () => exportRecords('csv'));
  previousButton.addEventListener('click', () => {
    if (activeFilters.page <= 1) return;
    activeFilters.page -= 1;
    loadDashboard();
  });
  nextButton.addEventListener('click', () => {
    activeFilters.page += 1;
    loadDashboard();
  });
  pageSizeInput.addEventListener('change', () => {
    activeFilters.pageSize = Number(pageSizeInput.value);
    activeFilters.page = 1;
    loadDashboard();
  });

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 29);
  startInput.value = localDate(thirtyDaysAgo);
  endInput.value = localDate(today);
  activeFilters = {
    startDate: startInput.value,
    endDate: endInput.value,
    mo: '', part: '', printer: '', search: '',
    view: 'cartons', page: 1, pageSize: Number(pageSizeInput.value)
  };
  loadDashboard();
})();
