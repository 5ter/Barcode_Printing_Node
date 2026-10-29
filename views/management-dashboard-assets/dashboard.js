(() => {
  const form = document.getElementById('filter-form');
  const startInput = document.getElementById('start-date');
  const endInput = document.getElementById('end-date');
  const printerInput = document.getElementById('printer-filter');
  const pageSizeInput = document.getElementById('page-size');
  const tableHead = document.getElementById('table-head');
  const tableBody = document.getElementById('table-body');
  const notice = document.getElementById('notice');
  const refreshButton = document.getElementById('refresh-button');
  const exportExcelButton = document.getElementById('export-excel-button');
  const exportCsvButton = document.getElementById('export-csv-button');
  const previousButton = document.getElementById('previous-page');
  const nextButton = document.getElementById('next-page');

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

  function productLabelSearchTerm() {
    return String(activeFilters && activeFilters.search || '').trim();
  }

  function isProductLabelSearchMatch(value) {
    const search = productLabelSearchTerm();
    return Boolean(search) && String(value ?? '').toLowerCase().includes(search.toLowerCase());
  }

  function escapeAndHighlightSearch(value) {
    const text = String(value ?? '');
    const search = productLabelSearchTerm();
    if (!search) return escapeHtml(text);

    const lowerText = text.toLowerCase();
    const lowerSearch = search.toLowerCase();
    let cursor = 0;
    let matchAt = lowerText.indexOf(lowerSearch, cursor);
    let output = '';
    while (matchAt !== -1) {
      output += escapeHtml(text.slice(cursor, matchAt));
      output += `<mark class="search-hit-text">${escapeHtml(text.slice(matchAt, matchAt + search.length))}</mark>`;
      cursor = matchAt + search.length;
      matchAt = lowerText.indexOf(lowerSearch, cursor);
    }
    return output + escapeHtml(text.slice(cursor));
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
    document.getElementById('stat-pending').textContent = number(summary.cartonPrintPending);
    document.getElementById('stat-scans').textContent = number(summary.arnUnitScans);
    document.getElementById('stat-failed').textContent = number(summary.cartonPrintFailures);
  }

  function printerLabel(printer) {
    const shortId = String(printer.id || '').replace(/^PRINTER_/, 'Printer ');
    const details = [printer.name, printer.location].filter(value => value && value !== printer.id);
    return details.length ? `${shortId} — ${details.join(' · ')}` : shortId;
  }

  async function loadPrinterOptions() {
    const selectedPrinter = printerInput.value;
    try {
      const response = await fetch('/api/management-dashboard/printers', {
        headers: { Accept: 'application/json' }, cache: 'no-store'
      });
      const result = await response.json();
      if (!response.ok || result.status !== 'success') {
        throw new Error(result.message || 'Could not load the configured printer list.');
      }

      printerInput.replaceChildren();
      const allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'All printers';
      printerInput.appendChild(allOption);
      for (const printer of result.printers || []) {
        const option = document.createElement('option');
        option.value = printer.id;
        option.textContent = printerLabel(printer);
        printerInput.appendChild(option);
      }
      printerInput.value = [...printerInput.options].some(option => option.value === selectedPrinter)
        ? selectedPrinter
        : '';
    } catch (error) {
      showNotice(error.message);
    }
  }

  function renderCartons(rows) {
    tableHead.innerHTML = `<tr>
      <th>Mfr Ref No. / Carton</th><th>Job details</th><th>Carton contents</th>
      <th>Quantity</th><th>Print state</th><th>Printer / printed</th>
    </tr>`;
    if (!rows.length) {
      tableBody.innerHTML = '<tr><td class="empty-state" colspan="6">No ARN carton label records or scanned product labels match these filters.</td></tr>';
      return;
    }

    tableBody.innerHTML = rows.map(row => {
      const cartonId = row.cartonId ? String(row.cartonId) : '';
      const canExpand = Boolean(cartonId);
      const capacity = row.boxCapacity || row.labelQuantity || '—';
      const scanned = Number(row.scannedCount || row.activeScanCount || 0);
      const cartonStatus = row.cartonStatus ? `<span class="carton-status">${escapeHtml(row.cartonStatus)}</span>` : '';
      const matchingProductLabel = row.matchingProductLabel
        ? `<div class="search-match"><span>Product-label search match</span>${escapeAndHighlightSearch(row.matchingProductLabel)}</div>`
        : '';
      const rowAttributes = canExpand
        ? ` data-carton-id="${escapeHtml(cartonId)}" tabindex="0" aria-label="Show product labels in manufacturer reference ${escapeHtml(row.labelReference || cartonId)}"`
        : '';
      return `<tr class="data-row carton-row"${rowAttributes}>
        <td class="reference-cell"><button class="expand-button" type="button" data-carton-id="${escapeHtml(cartonId)}" aria-expanded="false" ${canExpand ? '' : 'disabled'} title="${canExpand ? 'Show product labels in this carton' : 'No carton scan record is linked'}">›</button><span class="reference-content"><span class="row-kicker">MFR REF NO.</span><span class="reference-code">${escapeHtml(row.labelReference || '—')}</span><span class="minor">${cartonId ? `Carton #${escapeHtml(cartonId)}` : 'Historical label without scan link'}</span></span></td>
        <td class="job-cell"><div class="job-line"><span>MO</span><span class="code">${escapeHtml(row.mo || '—')}</span></div><div class="job-line"><span>ARN</span><span class="code">${escapeHtml(row.arnPartNo || '—')}</span></div><div class="job-line"><span>MFR</span><span class="code">${escapeHtml(row.manufacturerPartNo || '—')}</span></div><div class="job-line"><span>PO</span><span class="code">${escapeHtml(row.purchaseOrder || '—')}</span></div></td>
        <td><span class="quantity">${number(row.activeScanCount)} label${Number(row.activeScanCount) === 1 ? '' : 's'}</span><div class="minor">${canExpand ? 'Click row to inspect carton contents' : 'No scan link is stored'}</div>${matchingProductLabel}</td>
        <td><span class="quantity">${number(scanned)} / ${escapeHtml(capacity)}</span>${cartonStatus}</td>
        <td>${statusTag(row.printStatus)}<div class="minor">YYWW ${escapeHtml(row.dateCode || '—')} · Item ${escapeHtml(row.itemNo || '—')}</div></td>
        <td class="printer-cell"><span class="code">${escapeHtml(row.printerId || '—')}</span><div class="printed-at">${displayDate(row.printedAt)}</div></td>
      </tr>`;
    }).join('');
  }

  function renderPagination(pagination) {
    const start = pagination.total ? ((pagination.page - 1) * pagination.pageSize) + 1 : 0;
    const end = Math.min(pagination.page * pagination.pageSize, pagination.total);
    document.getElementById('result-range').textContent = `Showing ${number(start)}–${number(end)} of ${number(pagination.total)} carton labels`;
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
      renderCartons(result.rows);
      renderPagination(result.pagination);
      document.getElementById('last-updated').textContent = `Updated ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      tableHead.innerHTML = '';
      tableBody.innerHTML = `<tr><td class="empty-state" colspan="6">${escapeHtml(error.message)}</td></tr>`;
      document.getElementById('result-range').textContent = 'Unable to load records';
      showNotice(error.message);
    } finally {
      if (currentRequest === requestNumber) setLoading(false);
    }
  }

  async function showCartonScans(row) {
    const cartonId = row.dataset.cartonId;
    if (!cartonId) return;
    const button = row.querySelector('.expand-button');
    const existingDetails = row.nextElementSibling;
    if (existingDetails && existingDetails.dataset.cartonDetail === cartonId) {
      existingDetails.remove();
      button.setAttribute('aria-expanded', 'false');
      button.textContent = '›';
      row.classList.remove('is-expanded');
      return;
    }

    tableBody.querySelectorAll('tr.detail-row').forEach(detail => {
      const ownerRow = detail.previousElementSibling;
      if (ownerRow && ownerRow !== row) {
        ownerRow.classList.remove('is-expanded');
        const ownerButton = ownerRow.querySelector('.expand-button');
        if (ownerButton) {
          ownerButton.setAttribute('aria-expanded', 'false');
          ownerButton.textContent = '›';
        }
        detail.remove();
      }
    });
    if (existingDetails && existingDetails.classList.contains('detail-row')) existingDetails.remove();
    button.setAttribute('aria-expanded', 'true');
    button.textContent = '⌄';
    row.classList.add('is-expanded');
    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row';
    detailRow.dataset.cartonDetail = cartonId;
    detailRow.innerHTML = '<td colspan="6"><div class="detail-panel">Loading product labels…</div></td>';
    row.after(detailRow);

    try {
      const response = await fetch(`/api/management-dashboard/cartons/${encodeURIComponent(cartonId)}/scans`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Could not load carton contents.');
      const active = result.rows.filter(scan => !scan.removedAt).length;
      const removed = result.rows.length - active;
      const matchingScans = result.rows.filter(scan => isProductLabelSearchMatch(scan.scannedContent));
      const searchContext = matchingScans.length
        ? `<div class="search-detail-context"><span>Search match</span><strong>${number(matchingScans.length)} product label${matchingScans.length === 1 ? '' : 's'} highlighted below</strong><code>${escapeHtml(productLabelSearchTerm())}</code></div>`
        : '';
      const items = result.rows.length
        ? `<div class="scan-list">${result.rows.map((scan, index) => {
          const isMatch = isProductLabelSearchMatch(scan.scannedContent);
          return `<div class="scan-item${isMatch ? ' search-hit' : ''}">
            <div class="scan-content"><span class="scan-label">Product label ${String(index + 1).padStart(2, '0')}${isMatch ? '<span class="scan-hit-badge">SEARCH MATCH</span>' : ''}</span><span class="code">${isMatch ? escapeAndHighlightSearch(scan.scannedContent) : escapeHtml(scan.scannedContent)}</span></div>
            <div class="scan-meta">${scan.removedAt ? '<span class="status-tag status-removed">REMOVED</span>' : '<span class="status-tag status-in-carton">IN CARTON</span>'}<span class="scan-time">${displayDate(scan.removedAt || scan.scannedAt)}</span></div>
          </div>`;
        }).join('')}</div>`
        : '<p class="filter-help">No product labels are stored for this carton.</p>';
      detailRow.querySelector('.detail-panel').innerHTML = `<div class="detail-header"><strong>Product label details · ${number(active)} currently in carton</strong><span>${number(removed)} removed scan${removed === 1 ? '' : 's'} retained in audit history</span></div>${searchContext}${items}`;
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
      printer: printerInput.value,
      search: document.getElementById('search-filter').value.trim(),
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
    printerInput.value = '';
    document.getElementById('search-filter').value = '';
    activeFilters = collectFormFilters();
    loadDashboard();
  });

  tableBody.addEventListener('click', event => {
    const row = event.target.closest('tr.carton-row[data-carton-id]');
    if (!row) return;
    if (event.target.closest('button, a, input, select, label')) {
      if (event.target.closest('.expand-button')) showCartonScans(row);
      return;
    }
    showCartonScans(row);
  });
  tableBody.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr.carton-row[data-carton-id]');
    if (!row || event.target !== row) return;
    event.preventDefault();
    showCartonScans(row);
  });
  refreshButton.addEventListener('click', async () => {
    await loadPrinterOptions();
    loadDashboard();
  });
  function exportRecords(format) {
    const params = queryString(activeFilters);
    params.set('format', format);
    window.location.assign(`/api/management-dashboard/export?${params}`);
    showNotice('Export started for all filtered ARN carton labels.', true);
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
    page: 1, pageSize: Number(pageSizeInput.value)
  };
  loadPrinterOptions().finally(loadDashboard);
})();
