const crypto = require('crypto');
const rolePasswords = require('../config/authCredentials');

const COOKIE_NAME = 'actmax_role_session';
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const DEVELOPMENT_SECRET = 'actmax-local-development-only-change-before-production';
const VALID_ROLES = new Set(Object.keys(rolePasswords));
const PAGE_ROLE_ACCESS = Object.freeze({
    hub: Object.freeze(['OPERATOR', 'SUPERVISOR', 'ADMIN']),
    standard: Object.freeze(['OPERATOR', 'ADMIN']),
    arn: Object.freeze(['OPERATOR', 'ADMIN']),
    excel: Object.freeze(['SUPERVISOR', 'ADMIN']),
    printer: Object.freeze(['ADMIN']),
    download: Object.freeze(['ADMIN']),
    dashboard: Object.freeze(['SUPERVISOR', 'ADMIN'])
});

function getRolesForPage(page) {
    return PAGE_ROLE_ACCESS[String(page || '').trim().toLowerCase()] || [];
}

function getAccessiblePages(roleValue) {
    const role = String(roleValue || '').trim().toUpperCase();
    if (!VALID_ROLES.has(role)) return [];
    return Object.entries(PAGE_ROLE_ACCESS)
        .filter(([, allowedRoles]) => allowedRoles.includes(role))
        .map(([page]) => page);
}

function getSessionSecret() {
    if (process.env.AUTH_SESSION_SECRET) {
        return process.env.AUTH_SESSION_SECRET.length >= 32 ? process.env.AUTH_SESSION_SECRET : null;
    }
    try {
        const localSecret = require('../config/authSecret.local');
        if (localSecret && typeof localSecret.secret === 'string' && localSecret.secret.length >= 32) {
            return localSecret.secret;
        }
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
    return process.env.NODE_ENV === 'production' ? null : DEVELOPMENT_SECRET;
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    const width = Math.max(leftBuffer.length, rightBuffer.length, 1);
    const paddedLeft = Buffer.alloc(width);
    const paddedRight = Buffer.alloc(width);
    leftBuffer.copy(paddedLeft);
    rightBuffer.copy(paddedRight);
    const same = crypto.timingSafeEqual(paddedLeft, paddedRight);
    return same && leftBuffer.length === rightBuffer.length;
}

function verifyCredentials(roleValue, passwordValue) {
    const role = String(roleValue || '').trim().toUpperCase();
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    const expectedPassword = rolePasswords[role] || 'invalid-role-password';
    const passwordMatches = safeEqual(password, expectedPassword);
    return VALID_ROLES.has(role) && passwordMatches ? role : null;
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(role, now = Date.now()) {
    const secret = getSessionSecret();
    if (!secret) throw new Error('AUTH_SESSION_SECRET is required when NODE_ENV=production.');
    if (!VALID_ROLES.has(role)) throw new Error('Cannot create a session for an unknown role.');
    const payload = Buffer.from(JSON.stringify({ role, issuedAt: now, expiresAt: now + SESSION_LIFETIME_MS }))
        .toString('base64url');
    return payload + '.' + sign(payload, secret);
}

function getRoleFromToken(token, now = Date.now()) {
    const secret = getSessionSecret();
    if (!secret || typeof token !== 'string' || token.length > 2048) return null;
    const separator = token.indexOf('.');
    if (separator <= 0 || token.indexOf('.', separator + 1) !== -1) return null;
    const payload = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    if (!safeEqual(suppliedSignature, sign(payload, secret))) return null;

    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!VALID_ROLES.has(session.role) ||
            !Number.isSafeInteger(session.issuedAt) ||
            !Number.isSafeInteger(session.expiresAt) ||
            session.issuedAt > now ||
            session.expiresAt <= now ||
            session.expiresAt - session.issuedAt > SESSION_LIFETIME_MS) {
            return null;
        }
        return session.role;
    } catch (error) {
        return null;
    }
}

function readCookie(req, name) {
    const cookieHeader = req.headers && req.headers.cookie;
    if (!cookieHeader) return '';
    for (const segment of cookieHeader.split(';')) {
        const separator = segment.indexOf('=');
        if (separator === -1 || segment.slice(0, separator).trim() !== name) continue;
        try {
            return decodeURIComponent(segment.slice(separator + 1).trim());
        } catch (error) {
            return '';
        }
    }
    return '';
}

function getRequestRole(req) {
    return getRoleFromToken(readCookie(req, COOKIE_NAME));
}

function setSessionCookie(res, req, role) {
    const options = {
        httpOnly: true,
        sameSite: 'strict',
        secure: Boolean(req.secure),
        path: '/',
        maxAge: SESSION_LIFETIME_MS
    };
    res.cookie(COOKIE_NAME, createSessionToken(role), options);
}

function clearSessionCookie(res, req) {
    res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'strict',
        secure: Boolean(req.secure),
        path: '/'
    });
}

function authConfigurationReady() {
    return Boolean(getSessionSecret());
}

function requireRoles(allowedRoles, options = {}) {
    const allowed = new Set(allowedRoles.map(role => String(role).toUpperCase()));
    return (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        if (!authConfigurationReady()) {
            return res.status(503).send('Authentication is not configured. Set the same AUTH_SESSION_SECRET for the application services.');
        }

        const role = getRequestRole(req);
        if (role && allowed.has(role)) {
            req.authRole = role;
            return next();
        }

        const isApi = req.path.startsWith('/api/') || req.xhr ||
            String(req.headers.accept || '').includes('application/json');
        if (isApi || req.method !== 'GET' && req.method !== 'HEAD') {
            const status = role ? 403 : 401;
            return res.status(status).json({
                status: 'error',
                message: role
                    ? 'Your ' + role.toLowerCase() + ' role does not have access to this function.'
                    : 'Sign in with an authorized role to continue.',
                loginRequired: !role
            });
        }

        if (role) {
            return res.status(403).type('html').send(
                '<!doctype html><html lang="en"><meta charset="utf-8"><title>Access denied</title>' +
                '<body style="font:16px Segoe UI,Arial,sans-serif;max-width:620px;margin:12vh auto;padding:24px;color:#17253a">' +
                '<h1>Access denied</h1><p>Your current role does not have access to this page.</p>' +
            '<p><a href="' + escapeAttribute(typeof options.homeUrl === 'function' ? options.homeUrl(req) : options.homeUrl || '/') + '">Return to the Workstation Hub</a></p></body></html>'
            );
        }

        const redirect = typeof options.loginRedirect === 'function'
            ? options.loginRedirect(req)
            : '/?login=required&returnTo=' + encodeURIComponent(req.originalUrl || '/');
        return res.redirect(302, redirect);
    };
}

function requirePageAccess(page, options = {}) {
    const allowedRoles = getRolesForPage(page);
    if (allowedRoles.length === 0) {
        throw new Error('No role access is configured for page: ' + String(page));
    }
    return requireRoles(allowedRoles, options);
}

function escapeAttribute(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

module.exports = {
    COOKIE_NAME,
    SESSION_LIFETIME_MS,
    VALID_ROLES,
    getAccessiblePages,
    requirePageAccess,
    verifyCredentials,
    createSessionToken,
    getRoleFromToken,
    getRequestRole,
    setSessionCookie,
    clearSessionCookie,
    authConfigurationReady,
    requireRoles
};
