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
    OWNER: '/admin',
    PARENT: '/dashboard',
    COACH: '/dashboard',
    default: '/dashboard',
  },
};
```

### Role-based redirects

Getting this wrong reads as a broken login — an admin dropped on the public
home page will assume sign-in failed. Map every role the site actually uses,
and make `default` a signed-in destination (not `/`).

Admin status **outranks the org role**: a platform admin whose membership in
this org says `PARENT` still lands on `ADMIN`'s route. If a site needs
different logic, pass a function instead of a map:

```ts
postLoginRoutes: (ctx) =>
  ctx.isNewUser ? '/onboarding' : ctx.isAdmin ? '/admin' : '/dashboard'
```

`ctx` carries `role`, `globalRole`, `isAdmin`, `isNewUser`, `orgId`,
`profile`, and `returnTo`. A same-site `?returnTo=` always wins; off-site and
protocol-relative values are rejected.
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

### App Check

Start App Check with `RecoveringReCaptchaProvider` instead of Firebase's
`ReCaptchaEnterpriseProvider`:

```ts
import { initializeAppCheck } from 'firebase/app-check';
import { RecoveringReCaptchaProvider } from '@proslotbosllc/sso-kit';

initializeAppCheck(app, { provider: new RecoveringReCaptchaProvider(siteKey), isTokenAutoRefreshEnabled: true });
```

Firebase's provider stops trying for a whole day after one refused check
("App attestation failed"). Once App Check is enforced, that would leave a real
person, such as a coach with a tab open all day, unable to load anything from
Firebase until tomorrow, and signing in again would not help. This provider is
Firebase's with that one rule changed: it tries again with a fresh check after
30 seconds, then 1, 2, 5 and 15 minutes, then hourly. `onAppCheckStatus(listener)`
reports each refusal, recovery, fallback and lockout, for a site that wants to tell the person.

Give it the signed-in person's ID token and, when reCAPTCHA fails (Instagram's
and Facebook's browsers, blockers, school filters), it gets the same short-lived
token from proslot-api instead:

```ts
new RecoveringReCaptchaProvider(siteKey, {
  fallback: { getIdToken: async () => (auth.currentUser ? await auth.currentUser.getIdToken() : null) },
});
```

Since 1.16.0 the fallback waits (at most 5 seconds) for Firebase Auth to read the
signed-in person back on page load, when the site has started Auth. Before, the
first token was asked for while `auth.currentUser` was still null, the fallback
paused for a minute, and the page's first Firestore reads went out without a
token: under enforcement, a signed-in parent in Instagram's browser would have
been refused on every page load. Finding nobody signed in no longer pauses the
fallback; only a failed call to the API does.

### Lockout tracking

App Check gets enforced only after five days in which no real person was locked
out, so every page reports the requests enforcement would refuse, before anyone
is refused. `watchAppCheckLockouts(app)` watches the page's Firestore requests
(their start times only, from resource timing) against the times the page held
a valid App Check token, and for each kind of request that went out without
one, once per page load, writes a fixed line to `console.error`, which Tracer
records as one error per kind:

```
[app-check] Locked out: signed in · Google refused this browser · sign-in backup refused (HTTP 429) · Instagram in-app browser
```

The parts: who (`signed in` / `signed out`); why, which for this kit's provider
is Google's verdict (`Google refused this browser`, `Google's check could not run`)
followed by what the sign-in backup did (`no sign-in backup on this site`,
`sign-in backup refused (HTTP n)`, `sign-in backup unreachable`,
`sign-in backup gave an unreadable answer`, `sign-in backup could not get an ID token`,
`sign-in backup saw nobody signed in`), and otherwise
`App Check not running on this page`, `App Check started after Firestore`,
`no valid App Check token`, or another provider's error code
(`token request failed` when it has none); and the in-app browser if any. The
line never holds an address, a person, a token, a time or a count. Each kind
needs its own fix before enforcement; none of them may be left to lock people out.

`RecoveringReCaptchaProvider` starts the watch by itself. Every site also calls
it once, right after its App Check block, **unconditionally**: in the native
apps (another provider), on pages where App Check is off or failed to start, and
where it is on. Those first two are exactly the pages enforcement would break.

```ts
import { watchAppCheckLockouts } from '@proslotbosllc/sso-kit';

try {
  if (siteKey) initializeAppCheck(app, { provider: new RecoveringReCaptchaProvider(siteKey, { fallback }), isTokenAutoRefreshEnabled: true });
} catch (err) {
  console.warn('[firebase] App Check did not start:', err);
}
watchAppCheckLockouts(app); // optional: { onLockout: (lockout) => ... }
```

It never starts App Check or Auth, keeps nothing between page loads, and does
nothing on a developer's machine (localhost) or outside a browser. The iOS and
Android apps, which also serve from localhost, are watched.

### A sign-in that stops working

`SignInLostNotice` tells a signed-in person that their sign-in has expired and
offers to sign them in again. The api-client-kit (1.2.0 and later) decides when:
the API refused a request as signed out, a fresh token did not help, and the site
still shows the person signed in.

```tsx
import { SignInLostNotice, reportSignInLost, clearSignInLost, initiateSSO } from '@proslotbosllc/sso-kit';
import { createApiClient, firebaseTokenGetter } from '@proslotbosllc/api-client-kit';

createApiClient({
  apiBase, orgId,
  getToken: firebaseTokenGetter(() => auth.currentUser),
  isSignedIn: () => !!auth.currentUser,
  onSignInLost: reportSignInLost,
  onSignInRestored: clearSignInLost,
});

// near the root, once
<SignInLostNotice onSignInAgain={() => signOut(auth).then(() => initiateSSO(ssoConfig, { returnTo }))} />
```

Boys of Summer, 28 Oct 2026: an admin's tab left open overnight missed its token
refresh during a five-second network drop, and for ten minutes every signed-in
call was refused, a game edit included, while the page still showed him signed in.

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

CI publishes to npm on tag, signing in with npm trusted publishing (GitHub
OIDC): there is no npm token to store or rotate.
