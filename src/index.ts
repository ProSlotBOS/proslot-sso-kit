/**
 * @proslot/sso-kit
 *
 * Shared SSO + onboarding kit for ProSlot satellite sites.
 *
 * The hub (POST /api/sso/authorize, /token) is already centralized; this kit
 * unifies the CONSUMER half that each satellite previously hand-rolled.
 *
 * Quick start:
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
 *   // sign-in button
 *   <button onClick={() => initiateSSO(ssoConfig)}>Sign In</button>
 *
 * Canonical source of truth: proslot/sdk/sso-kit. Copy into a satellite as
 * src/lib/sso-kit/ (same convention as vite-tracer-plugin); re-copy to update.
 */

export * from './types';
export * from './client';
export { SSOCallback } from './SSOCallback';
export type { SSOCallbackProps } from './SSOCallback';
export { OnboardingFlow } from './OnboardingFlow';
export type { OnboardingFlowProps, OnboardingStep, OnboardingStepContext } from './OnboardingFlow';
