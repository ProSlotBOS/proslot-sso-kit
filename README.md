# @proslotbosllc/sso-kit

Shared SSO + onboarding kit for ProSlot satellite sites.

The ProSlot SSO **hub** (`POST /api/sso/authorize`, `/token`) is already
centralized. This package unifies the **consumer** half that each satellite
previously hand-rolled — there were ~9 divergent `SSOCallback` copies
(120–275 lines each) and three near-identical ~363-line onboarding pages.

Per-site behaviour is expressed as **configuration**, not as a forked copy of
the flow, so genuine differences between sites stay easy while the identical
80% is shared.

## Install

Published to public npm — no registry config, no tokens:

```bash
npm install @proslotbosllc/sso-kit
```

Semver ranges work as normal (`^1.1.0`), so a patch published here reaches
every satellite on its next install, and Dependabot can open update PRs
across the fleet.

`react >=18` and `firebase >=10` are peer dependencies.

## Usage

```ts
// src/lib/sso-config.ts
import type { SSOKitConfig } from '@proslotbosllc/sso-kit';

export const ssoConfig: SSOKitConfig = {
  clientId: 'yoursite',            // sso_clients doc id
  appName: 'Your Site',
  hashRouter: true,                // HashRouter apps → '/#/auth/callback'
  postLoginRoutes: {
    ADMIN: '/admin',
    PARENT: '/dashboard',
    default: '/',
  },
};
```

```tsx
// route: /auth/callback
import { SSOCallback } from '@proslotbosllc/sso-kit';
<SSOCallback config={ssoConfig} auth={auth} navigate={navigate} />

// sign-in button
import { initiateSSO } from '@proslotbosllc/sso-kit';
<button onClick={() => initiateSSO(ssoConfig)}>Sign In</button>
```

### Onboarding

`<OnboardingFlow>` runs an ordered array of steps you define — progress,
back/next, per-step validation and shared draft state are handled for you.
Steps can be conditional (`when`), so a role chosen in step 1 can reveal or
hide later steps.

```tsx
<OnboardingFlow
  role={role}
  steps={[profileStep, waiverStep, mySiteSpecificStep]}
  onComplete={async (data) => { await saveProfile(data); navigate('/'); }}
/>
```

## What the kit handles that hand-rolled copies missed

- **Hash-router callbacks** — `/#/auth/callback?code=…` extraction.
- **Single-use-code double-exchange guard** — React StrictMode mounts effects
  twice; the second exchange 401s and used to surface as a bogus error.
- **Role resolution without an extra round trip** — uses the hub's response
  instead of re-fetching `/api/users/by-firebase-uid`, which could race the
  write that auto-join had just performed.
- **Open-redirect protection** — `returnTo` is restricted to same-site paths.
- **Native shells** — `nativeRedirectUri` supports custom schemes
  (`com.proslot.bos://auth/callback`).

## Canonical roles

`OWNER, ADMIN, TRAINER, COACH, STAFF, PARENT, ATHLETE, MEMBER, CUSTOMER,
STUDENT, USER`. `OWNER`/`ADMIN` are privileged and are never granted by
self-service signup or SSO auto-join (the hub enforces this server-side too).

## Releasing

Bump `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v1.1.1 && git push origin v1.1.1
```

CI publishes to npm on tag. That requires an npm **Automation** token (it
bypasses 2FA) stored as the `NPM_TOKEN` repo secret.
