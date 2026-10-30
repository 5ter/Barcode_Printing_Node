document.addEventListener('DOMContentLoaded', () => {
    const body = document.body;
    const colorModeKey = 'actmax-color-mode';
    const mainPort = body.dataset.mainAppPort || (window.location.port && window.location.port !== '3005'
        ? window.location.port
        : '3003');
    const excelPort = body.dataset.excelAppPort || '3005';
    const downloadPort = body.dataset.downloadAppPort || '3006';
    let currentRole = null;
    let lastFocus = null;

    function getSavedColorMode() {
        const cookieMatch = document.cookie.match(/(?:^|; )actmax_color_mode=(dark|light)(?:;|$)/);
        if (cookieMatch) return cookieMatch[1];
        try {
            const saved = window.localStorage.getItem(colorModeKey);
            return saved === 'dark' || saved === 'light' ? saved : null;
        } catch (error) {
            return null;
        }
    }

    function applyColorMode(mode, persist = false) {
        const selectedMode = mode === 'light' ? 'light' : 'dark';
        document.documentElement.dataset.colorMode = selectedMode;
        document.documentElement.style.colorScheme = selectedMode;
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.content = selectedMode === 'dark' ? '#0d0912' : '#f8f9ff';
        if (!persist) return selectedMode;
        try {
            window.localStorage.setItem(colorModeKey, selectedMode);
        } catch (error) {
            // Cookie persistence still keeps the choice consistent across the main and Excel apps.
        }
        document.cookie = 'actmax_color_mode=' + selectedMode + '; Max-Age=31536000; Path=/; SameSite=Lax';
        return selectedMode;
    }

    let colorMode = applyColorMode(getSavedColorMode() || 'dark');

    function serviceUrl(port, pathname, query = {}) {
        const url = new URL(window.location.href);
        if (port !== null) url.port = String(port);
        url.pathname = pathname;
        url.search = '';
        url.hash = '';
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        return url.toString();
    }

    function makeLink(label, href, key) {
        const link = document.createElement('a');
        link.textContent = label;
        link.href = href;
        link.dataset.navKey = key;
        if (isCurrentPage(key)) link.setAttribute('aria-current', 'page');
        return link;
    }

    function isCurrentPage(key) {
        const path = window.location.pathname;
        if (key === 'hub') return path === '/' && window.location.port !== excelPort && window.location.port !== downloadPort;
        if (key === 'dashboard') return path === '/dashboard';
        if (key === 'printer') return path.startsWith('/printer-setup');
        if (key === 'excel') return window.location.port === excelPort && path === '/';
        if (key === 'download') return window.location.port === downloadPort && path === '/';
        if (key === 'arn') return path.startsWith('/arn/');
        if (key === 'standard') return path === '/standard';
        return false;
    }

    const shell = document.createElement('header');
    shell.className = 'app-shell-header';
    shell.setAttribute('role', 'banner');
    const brand = document.createElement('a');
    brand.className = 'app-shell-brand';
    brand.href = serviceUrl(mainPort, '/');
    brand.setAttribute('aria-label', 'ACTMAX Traceability System home');
    const brandLogo = document.createElement('img');
    brandLogo.className = 'app-shell-logo';
    brandLogo.src = '/image/actmax_logo.png';
    brandLogo.alt = '';
    brandLogo.width = 40;
    brandLogo.height = 40;
    brandLogo.decoding = 'async';
    const brandCopy = document.createElement('span');
    brandCopy.className = 'app-shell-brand-copy';
    const brandName = document.createElement('strong');
    brandName.innerHTML = 'ACTMAX <span aria-hidden="true">&gt;&gt;</span>';
    const brandCaption = document.createElement('small');
    brandCaption.textContent = 'TRACEABILITY SYSTEM';
    brandCopy.append(brandName, brandCaption);
    brand.append(brandLogo, brandCopy);

    const nav = document.createElement('nav');
    nav.className = 'app-shell-nav';
    nav.setAttribute('aria-label', 'Main navigation');
    const links = {
        hub: makeLink('Workstation Hub', serviceUrl(mainPort, '/'), 'hub'),
        standard: makeLink('Standard Label', serviceUrl(mainPort, '/standard'), 'standard'),
        arn: makeLink('ARN Workflow', serviceUrl(mainPort, '/arn/setup'), 'arn'),
        excel: makeLink('Excel Upload', serviceUrl(excelPort, '/'), 'excel'),
        download: makeLink('Download Data', serviceUrl(downloadPort, '/'), 'download'),
        printer: makeLink('Printer Setup', serviceUrl(mainPort, '/printer-setup'), 'printer'),
        dashboard: makeLink('Dashboard', serviceUrl(mainPort, '/dashboard'), 'dashboard')
    };
    nav.append(links.hub, links.standard, links.arn, links.excel, links.printer, links.dashboard, links.download);

    const account = document.createElement('div');
    account.className = 'app-shell-account';
    const themeButton = document.createElement('button');
    themeButton.type = 'button';
    themeButton.className = 'app-shell-theme-toggle';
    const roleBadge = document.createElement('span');
    roleBadge.className = 'app-shell-role';
    roleBadge.hidden = true;
    const accountButton = document.createElement('button');
    accountButton.type = 'button';
    account.append(themeButton, roleBadge, accountButton);
    shell.append(brand, nav, account);
    body.insertBefore(shell, body.firstChild);

    const layer = document.createElement('div');
    layer.className = 'auth-modal-layer';
    layer.hidden = true;
    layer.innerHTML =
        '<section class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="authTitle" tabindex="-1">' +
        '<h2 id="authTitle">Sign in to ACTMAX</h2>' +
        '<p>Select your role and enter its password to open the pages available to that role.</p>' +
        '<form id="authForm" autocomplete="on">' +
        '<label for="authRole">User type<select id="authRole" name="role" required>' +
        '<option value="OPERATOR">Operator</option><option value="SUPERVISOR">Supervisor</option><option value="ADMIN">Admin</option>' +
        '</select></label>' +
        '<label for="authPassword">Password<input id="authPassword" name="password" type="password" autocomplete="current-password" required></label>' +
        '<div id="authError" class="auth-modal-error" role="alert" aria-live="polite"></div>' +
        '<div class="auth-modal-actions"><button id="authCancel" type="button">Cancel</button><button id="authSubmit" type="submit">Sign in</button></div>' +
        '</form></section>';
    body.append(layer);

    const dialog = layer.querySelector('.auth-modal');
    const authForm = layer.querySelector('#authForm');
    const authError = layer.querySelector('#authError');
    const authPassword = layer.querySelector('#authPassword');
    const authSubmit = layer.querySelector('#authSubmit');

    function openModal() {
        lastFocus = document.activeElement;
        layer.hidden = false;
        authError.textContent = '';
        window.setTimeout(() => authPassword.focus(), 0);
    }

    function closeModal() {
        layer.hidden = true;
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }

    function updateNavigation(role, accessiblePages = []) {
        const normalizedRole = String(role || '').trim().toUpperCase();
        currentRole = normalizedRole || null;
        const pages = new Set(Array.isArray(accessiblePages)
            ? accessiblePages.map(page => String(page).trim().toLowerCase())
            : []);
        const isSignedIn = Boolean(currentRole);
        for (const page of ['standard', 'arn', 'excel', 'printer', 'dashboard', 'download']) {
            links[page].hidden = !pages.has(page);
        }
        document.querySelectorAll('[data-role-page]').forEach(element => {
            element.hidden = !pages.has(String(element.dataset.rolePage || '').trim().toLowerCase());
        });
        const workflowGrid = document.getElementById('workflowGrid');
        const workflowAccessNote = document.getElementById('workflowAccessNote');
        const canRunWorkflow = pages.has('arn') || pages.has('standard');
        if (workflowGrid) workflowGrid.hidden = !canRunWorkflow;
        if (workflowAccessNote) {
            workflowAccessNote.hidden = canRunWorkflow;
            if (!currentRole) {
                workflowAccessNote.textContent = 'Sign in to see the pages available to your role.';
            } else if (!canRunWorkflow) {
                workflowAccessNote.textContent = 'Your role does not include label-printing workflows. Use Excel Upload or Dashboard in the navigation above.';
            }
        }
        const stationNote = document.querySelector('.station-note');
        if (stationNote) stationNote.hidden = !canRunWorkflow;
        roleBadge.hidden = !isSignedIn;
        roleBadge.textContent = currentRole ? currentRole.charAt(0) + currentRole.slice(1).toLowerCase() : '';
        accountButton.textContent = isSignedIn ? 'Sign out' : 'Sign in';
        accountButton.setAttribute('aria-label', isSignedIn ? 'Sign out of ACTMAX' : 'Sign in to ACTMAX');
        window.dispatchEvent(new CustomEvent('actmax:role-ready', {
            detail: { role: currentRole, accessiblePages: [...pages] }
        }));
    }

    function updateThemeButton() {
        const isDark = colorMode === 'dark';
        themeButton.textContent = isDark ? '\u2600 Light' : '\u263e Dark';
        themeButton.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
        themeButton.title = themeButton.getAttribute('aria-label');
    }

    updateNavigation(null, []);
    updateThemeButton();

    async function loadCurrentRole() {
        try {
            const response = await fetch('/auth/me', { cache: 'no-store', credentials: 'same-origin' });
            const result = await response.json();
            updateNavigation(
                response.ok && result.status === 'success' ? result.role : null,
                response.ok && result.status === 'success' ? result.accessiblePages : []
            );
        } catch (error) {
            updateNavigation(null, []);
        }
    }

    function pageForTarget(target) {
        const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
        const pathname = target.pathname;
        if (targetPort === String(excelPort)) return 'excel';
        if (targetPort === String(downloadPort)) return 'download';
        if (targetPort !== String(mainPort)) return null;
        if (pathname === '/') return 'hub';
        if (pathname === '/standard' || pathname === '/ajax.js' || pathname.startsWith('/submit-data')) return 'standard';
        if (pathname === '/arn' || pathname.startsWith('/arn/') || pathname === '/retry-arn-print') return 'arn';
        if (pathname.startsWith('/printer-setup') || pathname.startsWith('/api/printer-setup')) return 'printer';
        if (pathname.startsWith('/dashboard') || pathname.startsWith('/api/management-dashboard')) return 'dashboard';
        if (pathname === '/fetch-data') return 'download';
        return null;
    }

    function getSafeReturnTarget(accessiblePages = []) {
        const requested = new URL(window.location.href).searchParams.get('returnTo');
        if (!requested) return null;
        try {
            const target = new URL(requested, window.location.origin);
            const allowedPorts = new Set([String(mainPort), String(excelPort), String(downloadPort)]);
            if (target.hostname !== window.location.hostname || target.protocol !== window.location.protocol) return null;
            if (target.origin !== window.location.origin &&
                !allowedPorts.has(target.port || (target.protocol === 'https:' ? '443' : '80'))) return null;
            const targetPage = pageForTarget(target);
            if (targetPage && targetPage !== 'hub' && !accessiblePages.includes(targetPage)) return null;
            return target.toString();
        } catch (error) {
            return null;
        }
    }

    accountButton.addEventListener('click', async () => {
        if (!currentRole) {
            openModal();
            return;
        }
        accountButton.disabled = true;
        try {
            await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } finally {
            const isProtectedPage = window.location.pathname.startsWith('/arn/') ||
                window.location.pathname.startsWith('/printer-setup') ||
                window.location.port === excelPort || window.location.port === downloadPort;
            if (isProtectedPage) window.location.assign(serviceUrl(mainPort, '/'));
            else window.location.reload();
        }
    });
    themeButton.addEventListener('click', () => {
        colorMode = applyColorMode(colorMode === 'dark' ? 'light' : 'dark', true);
        updateThemeButton();
    });
    layer.querySelector('#authCancel').addEventListener('click', closeModal);
    layer.addEventListener('click', event => { if (event.target === layer) closeModal(); });
    document.addEventListener('keydown', event => {
        if (layer.hidden) return;
        if (event.key === 'Escape') closeModal();
        if (event.key === 'Tab') {
            const focusable = Array.from(dialog.querySelectorAll('button:not(:disabled), input, select'));
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
    authForm.addEventListener('submit', async event => {
        event.preventDefault();
        authError.textContent = '';
        authSubmit.disabled = true;
        authSubmit.textContent = 'Signing in…';
        try {
            const response = await fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    role: layer.querySelector('#authRole').value,
                    password: authPassword.value
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Sign in failed.');
            authPassword.value = '';
            layer.hidden = true;
            const returnTarget = getSafeReturnTarget(result.accessiblePages || []);
            if (returnTarget) window.location.assign(returnTarget);
            else if (new URL(window.location.href).searchParams.has('returnTo')) {
                window.location.assign(serviceUrl(mainPort, '/'));
            } else window.location.reload();
        } catch (error) {
            authError.textContent = error.message;
            authPassword.select();
        } finally {
            authSubmit.disabled = false;
            authSubmit.textContent = 'Sign in';
        }
    });

    loadCurrentRole();
    if (new URL(window.location.href).searchParams.get('login') === 'required') openModal();
});
