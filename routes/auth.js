const express = require('express');
const {
    verifyCredentials,
    getRequestRole,
    getAccessiblePages,
    setSessionCookie,
    clearSessionCookie,
    authConfigurationReady
} = require('../utils/auth');

const router = express.Router();
const attemptsByIp = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function validSameOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return true;
    return origin === req.protocol + '://' + req.get('host');
}

function getAttemptRecord(ip, now) {
    let record = attemptsByIp.get(ip);
    if (!record || record.resetAt <= now) {
        record = { count: 0, resetAt: now + WINDOW_MS };
        attemptsByIp.set(ip, record);
    }
    return record;
}

router.get('/auth/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!authConfigurationReady()) {
        return res.status(503).json({ status: 'error', role: null, message: 'Authentication is not configured.' });
    }
    const role = getRequestRole(req);
    return res.json({ status: 'success', role, accessiblePages: getAccessiblePages(role) });
});

router.post('/auth/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!validSameOrigin(req)) {
        return res.status(403).json({ status: 'error', message: 'Login requests must come from this application.' });
    }
    if (!authConfigurationReady()) {
        return res.status(503).json({
            status: 'error',
            message: 'Authentication is not configured. Set AUTH_SESSION_SECRET to the same value for all application services.'
        });
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempts = getAttemptRecord(ip, now);
    if (attempts.count >= MAX_ATTEMPTS) {
        return res.status(429).json({ status: 'error', message: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
    }

    const role = verifyCredentials(req.body && req.body.role, req.body && req.body.password);
    if (!role) {
        attempts.count++;
        return res.status(401).json({ status: 'error', message: 'The selected role or password is incorrect.' });
    }

    attemptsByIp.delete(ip);
    try {
        setSessionCookie(res, req, role);
        return res.json({
            status: 'success',
            role: role.toLowerCase(),
            accessiblePages: getAccessiblePages(role)
        });
    } catch (error) {
        return res.status(503).json({ status: 'error', message: error.message });
    }
});

router.post('/auth/logout', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!validSameOrigin(req)) {
        return res.status(403).json({ status: 'error', message: 'Logout requests must come from this application.' });
    }
    clearSessionCookie(res, req);
    return res.json({ status: 'success' });
});

module.exports = router;
