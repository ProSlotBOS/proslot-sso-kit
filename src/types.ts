/**
 * @proslot/sso-kit — shared types
 *
 * Canonical role vocabulary + the config shape each satellite supplies.
 * Site-specific behaviour is expressed as DATA here, not as a forked copy of
 * the flow — that is the whole point of the kit.
 */

/** Canonical roles across the ProSlot ecosystem. Sites opt into a subset. */
export const PROSLOT_ROLES = [
  'OWNER',          // facility/business owner — highest org privilege
  'ADMIN',          // org administrator
  'FACILITY_OWNER', // facility owner variant (HomeTeam lineage)
  'PLATFORM_ADMIN', // platform infrastructure role (rules/middleware enforced)
  'DIRECTOR',       // league director (admin-assigned)
  'UMPIRE',         // league umpire (admin-assigned)
  'SPORTSORG',      // partner sports organisation (admin-assigned)
  'TRAINER',        // session trainer — admin-assigned, distinct from COACH
  'COACH',          // team coach — league self-signup default
  'PARENT',         // parent/guardian
  'ATHLETE',        // athlete/player
  'STUDENT',        // advisory student (EPA)
  'CUSTOMER',       // storefront customer
  'USER',           // default/unassigned
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
  /**
   * Block sign-in completion until the account has a first name, last name,
   * and phone number, prompting for whichever are missing (default true).
   * Historical signup paths allowed accounts through without them; this is
   * the fleet-wide backstop that repairs those profiles at next sign-in.
   */
  requireCompleteProfile?: boolean;
  /** True for HashRouter apps — builds '/#/auth/callback' redirect URIs. */
  hashRouter?: boolean;
  /**
   * Native/Capacitor custom-scheme callback, e.g. 'com.proslot.bos://auth/callback'.
   * When set (and no explicit origin is passed) it is used verbatim as the
   * redirect URI, so the same config works in a native shell.
   */
  nativeRedirectUri?: string;
  /**
   * Where to send a user after successful sign-in.
   *
   * Role-based redirects are load-bearing: landing an admin on the public
   * home page instead of their dashboard reads as a broken login.
   *
   * Map form — keyed by UPPERCASE role, `default` required:
   *     { ADMIN: '/admin', PARENT: '/dashboard', default: '/dashboard' }
   *
   * Function form — for sites whose routing needs more than the role
   * (e.g. a global role that outranks the org role, or new-user onboarding):
   *     (ctx) => ctx.isAdmin ? '/admin' : '/dashboard'
   *
   * A same-site `?returnTo=` / `state` path always wins over both.
   */
  postLoginRoutes: ({ default: string } & Record<string, string>)
    | ((ctx: PostLoginContext) => string);
  /**
   * Optional: force new users through onboarding. Return a path to redirect
   * to, or null to continue to the normal destination.
   */
  onboardingGate?: (ctx: { role: string; profile: GlobalProfile; isNewUser: boolean }) => string | null;
  /**
   * Legacy per-client secret some hub clients still require. Anything shipped
   * in a browser bundle is public — this is a compatibility knob, not a
   * security control.
   */
  clientSecret?: string;
  /** Persist the profile for immediate use by app auth context (default true). */
  primeLocalStorage?: boolean;
  /** localStorage key for the primed profile. */
  profileStorageKey?: string;
}

/** Everything known about the user at redirect time. */
export interface PostLoginContext {
  /** Org-scoped role for this client, uppercased (e.g. 'PARENT'). */
  role: string;
  /** Root-level role on the user record, uppercased. May differ from `role`. */
  globalRole: string;
  /**
   * True when EITHER role is privileged. Satellites consistently treat a
   * global ADMIN as an admin even when their org role is lower, so the kit
   * computes it once rather than each site re-deriving it.
   */
  isAdmin: boolean;
  /** First time this user has been seen in this org. */
  isNewUser: boolean;
  orgId: string;
  profile: GlobalProfile;
  returnTo: string | null;
}

export const DEFAULTS = {
  apiBase: 'https://proslot-api-473053764604.us-central1.run.app',
  hubUrl: 'https://proslotbos.com',
  callbackPath: '/auth/callback',
  profileStorageKey: 'proslot_user_profile',
};
