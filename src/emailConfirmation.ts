/**
 * Email confirmation from a page that was refused because the signed-in account has not proved its address.
 *
 * The API refuses anything handed out by email (a co-parent invite, an extended-family invite, a roster spot) until the
 * account owns that address, with HTTP 403 and `reason: 'email_not_verified'`. A page that only shows the refusal is a
 * dead end: a co-parent at Kingdom signed up, was refused seven seconds later, and clicked the confirmation link with
 * nothing on the page to retry (2026-11-02). These two calls are the way forward:
 *
 *   isEmailNotConfirmed(err)            the refusal is this one (the api-client-kit's ApiRefusal carries the reason as `code`)
 *   resendEmailConfirmation(config, t)  sends the ProSlot "confirm your email" message again, naming this site
 *   refreshEmailConfirmed(user)         after they click the link: re-reads the account and gets a fresh ID token, which
 *                                       is what the API reads. Without the fresh token the API keeps refusing for up to
 *                                       an hour, because the old token still says the address is unconfirmed.
 */
import type { User } from 'firebase/auth';
import { DEFAULTS, type SSOKitConfig } from './types.js';

const NOT_CONFIRMED = 'email_not_verified';

/** Is this error the API's "confirm your email first" refusal? */
export function isEmailNotConfirmed(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; reason?: unknown; status?: unknown; message?: unknown };
  if (e.code === NOT_CONFIRMED || e.reason === NOT_CONFIRMED) return true;
  // A client that keeps only the message: every such refusal asks the person to verify their email address.
  return e.status === 403 && typeof e.message === 'string' && /verify your email/i.test(e.message);
}

export type ResendResult =
  | { status: 'sent' }
  | { status: 'already-confirmed' }
  | { status: 'wait'; message: string }
  | { status: 'failed'; message: string };

/** Sends the confirmation email again. `idToken` is the signed-in account's Firebase ID token. */
export async function resendEmailConfirmation(
  config: Pick<SSOKitConfig, 'clientId' | 'apiBase'>,
  idToken: string,
): Promise<ResendResult> {
  const apiBase = (config.apiBase || DEFAULTS.apiBase).replace(/\/$/, '');
  try {
    const res = await fetch(`${apiBase}/api/sso/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ clientId: config.clientId }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; alreadyVerified?: boolean };
    if (res.ok) return body.alreadyVerified ? { status: 'already-confirmed' } : { status: 'sent' };
    const message = body.error || 'We could not send the confirmation email. Please try again.';
    return res.status === 429 ? { status: 'wait', message } : { status: 'failed', message };
  } catch {
    return { status: 'failed', message: 'We could not reach ProSlot. Check your connection and try again.' };
  }
}

/** Re-reads the account and refreshes its ID token. Returns whether the address is now confirmed. */
export async function refreshEmailConfirmed(user: User): Promise<boolean> {
  await user.reload();
  if (!user.emailVerified) return false;
  await user.getIdToken(true);
  return true;
}
