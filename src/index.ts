/**
 * @proslotbosllc/sso-kit
 *
 * Shared SSO + onboarding kit for ProSlot satellite sites.
 *
 * The hub (POST /api/sso/authorize, /token) is already centralized; this kit
 * unifies the CONSUMER half that each satellite previously hand-rolled.
 *
 * Quick start:
 *
 * Install:  npm install @proslotbosllc/sso-kit
 *
 *   // src/lib/sso-config.ts
 *   export const ssoConfig: SSOKitConfig = {
 *     clientId: 'yoursite',
 *     appName: 'Your Site',
 *     hashRouter: false,
 *     postLoginRoutes: { ADMIN: '/admin', PARENT: '/dashboard', default: '/' },
 *   };
 *
 *   // route: /auth/callback
 *   <SSOCallback config={ssoConfig} auth={auth} navigate={navigate} />
 *
 *   // near the root, once: the Terms / Privacy step for anyone signed in who still owes it
 *   <LegalGate apiUrl={API_URL} appName="Your Site" clientId="yoursite" userKey={user?.uid}
 *     getIdToken={() => auth.currentUser?.getIdToken() ?? Promise.resolve(null)} onSignOut={() => signOut(auth)} />
 *
 *   // around admin and staff pages: the passkey second factor, when the org's switch requires it
 *   <PasskeyGate apiUrl={API_URL} org="yourorgid" appName="Your Site" userKey={user?.uid} getIdToken={...}
 *     onSignOut={() => signOut(auth)} onSignInAgain={() => initiateSSO(ssoConfig)}>{adminPages}</PasskeyGate>
 *
 *   // sign-in button
 *   <button onClick={() => initiateSSO(ssoConfig)}>Sign In</button>
 *
 * Consume this ONLY as the published npm package. Do not vendor a copy into
 * a satellite: the old proslot/sdk/sso-kit copy-in convention is retired, and
 * vendored copies silently go stale — ProslotBOS sat two releases behind on
 * one, missing the redirect_uri fix that native sign-in depends on.
 *
 * To update a satellite:  npm install @proslotbosllc/sso-kit@latest
 * Releasing a new version: see RELEASING.md
 */

export * from './types.js';
export * from './client.js';
export { SSOCallback } from './SSOCallback.js';
export type { SSOCallbackProps } from './SSOCallback.js';
export { OnboardingFlow } from './OnboardingFlow.js';
export { LegalGate, fetchLegalStatus, recordLegalAcceptance } from './LegalGate.js';
export type { LegalGateProps, LegalStatus, LegalDocument } from './LegalGate.js';
export { PasskeyGate, fetchPasskeyStatus, isPasskeyRefusal } from './PasskeyGate.js';
export type { PasskeyGateProps, PasskeyStatus } from './PasskeyGate.js';
export type { OnboardingFlowProps, OnboardingStep, OnboardingStepContext } from './OnboardingFlow.js';
