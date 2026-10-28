/**
 * App Check that recovers from a refusal in minutes instead of a day.
 *
 * Firebase's ReCaptchaEnterpriseProvider blocks every new attempt for 24 hours once the
 * exchange endpoint answers 403 ("App attestation failed"). A real person can meet one such
 * refusal: a coach's league tab left open all day had a background refresh refused on
 * 2026-10-26 and again on 10-27 (Tracer 1373cc53be10d39c, 884ee4d121027c7f). While App Check
 * only watches that costs nothing, but once Firebase enforces it the tab would be unable to
 * read anything from Firebase until the next day, and signing in again would not help: the
 * check is about the browser, not the account.
 *
 * This is the same provider with that one rule changed. After a refusal it tries again with
 * a fresh reCAPTCHA check after 30 seconds, then 1, 2, 5 and 15 minutes, then hourly. Every
 * attempt is still judged by Google, so a bot gains nothing it did not have before; a person
 * whose refusal was a passing thing is back within a minute or two.
 *
 * Start App Check with it where a site used ReCaptchaEnterpriseProvider:
 *
 *   initializeAppCheck(app, { provider: new RecoveringReCaptchaProvider(siteKey), isTokenAutoRefreshEnabled: true });
 *
 * onAppCheckStatus(listener) reports each refusal and each recovery, for a site that wants to
 * tell the person when their browser keeps being refused.
 *
 * It relies on two details of Firebase's provider: the throttle it keeps in `_throttleData`,
 * and the `appCheck/initial-throttle` error carrying `customData.httpStatus`. test/appCheck
 * pins both against the installed Firebase, so an upgrade that changes them fails the kit's
 * tests before a release. If they ever went missing at runtime, this behaves exactly like
 * Firebase's own provider.
 */
import { ReCaptchaEnterpriseProvider } from 'firebase/app-check';

/** Wait before each new attempt after a refusal, by refusals in a row; the last repeats. */
export const APP_CHECK_RETRY_AFTER_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000];

export type AppCheckStatus =
  | { state: 'refused'; inARow: number; retryInMs: number }
  | { state: 'recovered'; afterRefusals: number };

const listeners = new Set<(status: AppCheckStatus) => void>();

/** Hear about refusals and recoveries. Returns a function that stops listening. */
export function onAppCheckStatus(listener: (status: AppCheckStatus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function tell(status: AppCheckStatus): void {
  for (const listener of listeners) {
    try { listener(status); } catch { /* a listener's failure is not App Check's */ }
  }
}

type Throttle = { backoffCount: number; allowRequestsAfter: number; httpStatus: number };
interface ProviderInternals {
  _throttleData?: Throttle | null;
  getToken(isLimitedUse?: boolean): Promise<unknown>;
}

export class RecoveringReCaptchaProvider extends ReCaptchaEnterpriseProvider {
  private refusalsInARow = 0;

  /** @internal Called by Firebase; same contract as ReCaptchaEnterpriseProvider.getToken. */
  async getToken(isLimitedUse = false): Promise<unknown> {
    const base = ReCaptchaEnterpriseProvider.prototype as unknown as ProviderInternals;
    try {
      const token = await base.getToken.call(this, isLimitedUse);
      if (this.refusalsInARow > 0) {
        const afterRefusals = this.refusalsInARow;
        this.refusalsInARow = 0;
        console.info(`[app-check] recovered after ${afterRefusals} refused ${afterRefusals === 1 ? 'check' : 'checks'}`);
        tell({ state: 'recovered', afterRefusals });
      }
      return token;
    } catch (err) {
      const e = err as { code?: string; customData?: { httpStatus?: number } } | null;
      const self = this as unknown as ProviderInternals;
      // Only the refusal itself (403) gets the shorter wait. A 404 means the site is
      // misconfigured, and Firebase's day-long pause is right for that.
      if (e?.code === 'appCheck/initial-throttle' && e.customData?.httpStatus === 403 && self._throttleData) {
        const retryInMs = APP_CHECK_RETRY_AFTER_MS[Math.min(this.refusalsInARow, APP_CHECK_RETRY_AFTER_MS.length - 1)];
        this.refusalsInARow += 1;
        self._throttleData = { ...self._throttleData, allowRequestsAfter: Date.now() + retryInMs };
        tell({ state: 'refused', inARow: this.refusalsInARow, retryInMs });
      }
      throw err;
    }
  }
}
