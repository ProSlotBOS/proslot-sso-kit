/**
 * @proslot/sso-kit — shared types
 *
 * Canonical role vocabulary + the config shape each satellite supplies.
 * Site-specific behaviour is expressed as DATA here, not as a forked copy of
 * the flow — that is the whole point of the kit.
 */

/** Canonical roles across the ProSlot ecosystem. Sites opt into a subset. */
export const PROSLOT_ROLES = [
  'OWNER',    // facility/business owner — highest org privilege
  'ADMIN',    // org administrator
  'TRAINER',  // coach/trainer delivering sessions
  'COACH',    // team coach (league context)
  'STAFF',    // non-coaching staff
  'PARENT',   // guardian of an athlete
  'ATHLETE',  // participant (18+ or self-managed)
  'MEMBER',   // generic membership
  'CUSTOMER', // commerce-only relationship
  'STUDENT',  // education context
  'USER',     // default / unclassified
] as const;

export type ProSlotRole = (typeof PROSLOT_ROLES)[number];

/** Roles that must never be granted by self-service signup or auto-join. */
export const PRIVILEGED_ROLES: ProSlotRole[] = ['OWNER', 'ADMIN'];

export const isPrivilegedRole = (role?: string | null): boolean =>
  !!role && PRIVILEGED_ROLES.includes(role.toUpperCase() as ProSlotRole);

/** Server-side client config (GET /api/sso/client-config/:clientId). */
export interface SSOClientConfig {
  clientId: string;
  orgId: string | null;
  name: string;
  branding: { logoUrl: string | null; accentColor: string | null; bgColor: string | null };
  defaultRole: string;
  roleOptions: { value: string; label: string; description?: string; icon?: string }[];
  allowAutoJoin: boolean;
}

/** What the hub returns from POST /api/sso/token. */
export interface SSOTokenResponse {
  customToken: string;
  globalProfile: GlobalProfile;
  orgId: string;
  role: string;
}

export interface GlobalProfile {
  uid?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role?: string;
  organizations?: { orgId: string; role: string }[];
  [k: string]: unknown;
}

/**
 * Per-satellite kit configuration. Everything a site needs to differ on.
 */
export interface SSOKitConfig {
  /** sso_clients doc id, e.g. 'hometeamsports'. */
  clientId: string;
  /** Display name shown on the hub. Defaults to server config. */
  appName?: string;
  /** Core API base. Defaults to the production ProSlot API. */
  apiBase?: string;
  /** SSO hub origin. Defaults to https://proslotbos.com. */
  hubUrl?: string;
  /** Path this app serves the callback on. Default '/auth/callback'. */
  callbackPath?: string;
  /** True for HashRouter apps — builds '/#/auth/callback' redirect URIs. */
  hashRouter?: boolean;
  /**
   * Native/Capacitor custom-scheme callback, e.g. 'com.proslot.bos://auth/callback'.
   * When set (and no explicit origin is passed) it is used verbatim as the
   * redirect URI, so the same config works in a native shell.
   */
  nativeRedirectUri?: string;
  /**
   * Where to send a user after successful sign-in, by uppercased org role.
   * `default` is required; `_returnTo` (a ?returnTo param) always wins.
   */
  postLoginRoutes: { default: string } & Record<string, string>;
  /**
   * Optional: force new users through onboarding. Return a path to redirect
   * to, or null to continue to the normal destination.
   */
  onboardingGate?: (ctx: { role: string; profile: GlobalProfile; isNewUser: boolean }) => string | null;
  /** Persist the profile for immediate use by app auth context (default true). */
  primeLocalStorage?: boolean;
  /** localStorage key for the primed profile. */
  profileStorageKey?: string;
}

export const DEFAULTS = {
  apiBase: 'https://proslot-api-473053764604.us-central1.run.app',
  hubUrl: 'https://proslotbos.com',
  callbackPath: '/auth/callback',
  profileStorageKey: 'proslot_user_profile',
};
