# Authentication and role access

The app uses a role dropdown plus one shared password per role. The requested
passwords are kept in `config/authCredentials.js`. These are shared role
credentials, not individual accounts, so the system cannot identify which
person used a role. They are suitable only for a trusted internal network and
must not be treated as internet-grade authentication.

| Role | Access |
| --- | --- |
| Operator | ARN carton setup/scanning workflow; no Excel upload or printer setup |
| Supervisor | Operator workflow plus Excel upload and workbook templates |
| Admin | All role-protected pages, including printer setup |
| Everyone | Workstation Hub and management Dashboard |

The Standard label page and its Standard print endpoint intentionally remain
outside authentication/RBAC, as requested. The Hub's Standard workflow card
also remains available. Public workflow routing exposes the assigned printer
ID/name/letter only, not IP addresses or ports.

The separate legacy Standard-label CSV export service on port 3006 is unchanged
and remains outside the new authentication flow. The management Dashboard at
`/dashboard` on the main app is separate and remains publicly viewable.

Successful sign-in sets an HTTP-only, SameSite=Strict, eight-hour signed cookie.
The main app and Excel uploader must use the same session secret. In development
a clearly non-production fallback is used; when `NODE_ENV=production`,
authentication fails closed unless a secret
is supplied through `AUTH_SESSION_SECRET` or the ignored local file
`config/authSecret.local.js`.

## Production secret setup (PowerShell)

Run once in the application directory on the production server. The generated
value is stored in an ignored local config file and is not added to Git:

```powershell
$AuthSessionSecret = node -p "require('crypto').randomBytes(48).toString('base64url')"
$AuthSecretFile = Join-Path (Get-Location) 'config/authSecret.local.js'
Set-Content -LiteralPath $AuthSecretFile -Value "module.exports = { secret: '$AuthSessionSecret' };" -Encoding ascii
Remove-Variable AuthSessionSecret
pm2 restart ecosystem.config.js --update-env
```

Keep that file backed up securely and do not commit or share it. Restarting the
main app and Excel uploader with a different secret logs out every current
session. The role passwords themselves are intentionally hardcoded per
request; changing one requires a code deployment.
