# Releasing @proslotbosllc/sso-kit

Published manually from a logged-in machine (`npm whoami` → `proslotbos`).
npm 2FA is on, so each publish needs a one-time code.

```bash
# 1. bump the version (choose one)
npm version patch    # bug fix        1.1.0 -> 1.1.1
npm version minor    # new capability 1.1.0 -> 1.2.0
npm version major    # breaking       1.1.0 -> 2.0.0

# 2. publish (npm version already created the git tag)
npm publish --access public --otp=<6-digit code>

# 3. push commit + tag
git push origin main --follow-tags
```

Then bump consuming satellites (`"@proslotbosllc/sso-kit": "^1.2.0"`) and let
each site's PR preview verify before merge.

## Automated releases (trusted publishing)

Once the trusted publisher is registered on npmjs (package settings ->
Trusted Publisher -> GitHub Actions, repo `ProSlotBOS/proslot-sso-kit`,
workflow `publish.yml`), releases need no OTP and no stored secret:

```bash
npm version patch
git push origin main --follow-tags   # tag push triggers the publish
```

The workflow authenticates over OIDC and attaches build provenance, so npm
can verify the tarball came from this repo and commit.

## Why there is no token

npm removed legacy tokens in Nov 2025; granular tokens now *require* an
expiry, so a CI token becomes a recurring rotation chore that silently breaks
releases when it lapses. npm's own guidance is to use **trusted publishing**
(OIDC, no stored secret) instead.

Trusted publishing (above) replaces it entirely — nothing to rotate.
