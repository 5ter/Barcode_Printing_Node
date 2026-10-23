// Shared role passwords as requested for this small internal deployment.
// These are role credentials, not individual accounts; do not use them for
// internet-facing access or personal-account authentication.
module.exports = Object.freeze({
    OPERATOR: 'op123',
    SUPERVISOR: 'sv2026',
    ADMIN: '030398'
});
