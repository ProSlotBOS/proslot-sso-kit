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

## Why there is no CI publish workflow

npm removed legacy tokens in Nov 2025; granular tokens now *require* an
expiry, so a CI token becomes a recurring rotation chore that silently breaks
releases when it lapses. npm's own guidance is to use **trusted publishing**
(OIDC, no stored secret) instead.

If release volume ever justifies automating this, set up trusted publishing
rather than a token:
  - npm package settings -> Trusted Publisher -> GitHub Actions
    (repo `ProSlotBOS/proslot-sso-kit`, the publish workflow filename)
  - the workflow needs `permissions: { id-token: write }` and npm >= 11.5.1,
    which means Node 24 on the runner (Node 20 ships npm 10.x — too old).
