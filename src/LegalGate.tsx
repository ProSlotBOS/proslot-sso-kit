/**
 * @proslotbosllc/sso-kit — <LegalGate />
 *
 * The Terms of Service / Privacy Policy step, for someone already signed in.
 *
 * The SSO hub asks for acceptance when it issues an auth code, so it only
 * reaches people who sign in through it. Two kinds of account never pass that
 * point again: anyone who stayed signed in from before the documents existed
 * or changed (Firebase sessions last indefinitely), and anyone a site or app
 * signed in directly. On 16 Oct 2026, 68 of the 310 accounts active that week
 * had never accepted; 62 had last signed in before 7 Sep. Mounted once near a
 * site's root, this checks on load and shows the same step the hub shows.
 *
 *   <LegalGate
 *     apiUrl={API_URL}
 *     appName="Your Site"
 *     clientId="yoursite"
 *     userKey={user?.uid}                         // re-checks when the account changes
 *     getIdToken={() => auth.currentUser?.getIdToken() ?? Promise.resolve(null)}
 *     onSignOut={() => signOut(auth)}
 *     skip={isImpersonating}                      // staff "Log In As": consent is personal
 *   />
 *
 * It fails open: if the status check cannot be made, nothing is shown, so a
 * consent endpoint can never lock people out of a site. Styles are inline, so
 * it renders the same whatever CSS the site uses.
 */

import React, { useCallback, useEffect, useState } from 'react';

export interface LegalDocument { title: string; url: string; version: string }

export interface LegalStatus {
  outstanding: string[];
  documents: Record<string, LegalDocument>;
  hasRecord: boolean;
}

/** What this account still owes. Null when the check could not be made (fail open). */
export async function fetchLegalStatus(apiUrl: string, idToken: string): Promise<LegalStatus | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/legal/status`, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      outstanding: Array.isArray(data.outstanding) ? data.outstanding : [],
      documents: data.documents || {},
      hasRecord: !!data.hasRecord,
    };
  } catch {
    return null;
  }
}

/** Record acceptance of `documents` at their current versions. Throws with the API's message on failure. */
export async function recordLegalAcceptance(
  apiUrl: string,
  idToken: string,
  { documents, clientId, method }: { documents: string[]; clientId?: string; method: 'catchup' | 'reaccept' },
): Promise<void> {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/legal/accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents, method, ...(clientId ? { clientId } : {}) }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not record your acceptance');
  }
}

export interface LegalGateProps {
  apiUrl: string;
  appName: string;
  /** The site's SSO client id, recorded with the acceptance. */
  clientId?: string;
  /** Changes when the signed-in account changes (its uid); null or undefined when signed out. */
  userKey?: string | null;
  /** The signed-in account's Firebase ID token, or null. */
  getIdToken: () => Promise<string | null | undefined>;
  /** "Not now — sign out". Without it, the step offers no way out but agreeing. */
  onSignOut?: () => void | Promise<void>;
  /** Show nothing, e.g. while staff are signed in as someone else. */
  skip?: boolean;
}

const C = { ink: '#0B0B45', soft: '#8a8578', text: '#5a5648', line: '#e8e4dc', green: '#10b981', greenDark: '#059669', bg: 'rgba(11,11,69,.55)' };

export function LegalGate({ apiUrl, appName, clientId, userKey, getIdToken, onSignOut, skip = false }: LegalGateProps) {
  const [status, setStatus] = useState<LegalStatus | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setAgreed(false);
    setError('');
    if (skip || !userKey) return undefined;
    (async () => {
      const token = await getIdToken().catch(() => null);
      if (!token || cancelled) return;
      const s = await fetchLegalStatus(apiUrl, token);
      if (!cancelled && s && s.outstanding.length) setStatus(s);
    })();
    return () => { cancelled = true; };
    // getIdToken is usually an inline arrow; the account (userKey) is what should re-trigger the check.
  }, [apiUrl, userKey, skip]);

  const accept = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status || !agreed) return;
    setSaving(true);
    setError('');
    try {
      const token = await getIdToken();
      if (!token) throw new Error('You are signed out. Sign in again to continue.');
      await recordLegalAcceptance(apiUrl, token, { documents: status.outstanding, clientId, method: status.hasRecord ? 'reaccept' : 'catchup' });
      setStatus(null);
    } catch (err: any) {
      setError(err?.message || 'Could not record your acceptance');
    } finally {
      setSaving(false);
    }
  }, [status, agreed, getIdToken, apiUrl, clientId]);

  if (!status) return null;
  const docs = status.outstanding.filter((t) => status.documents[t]);
  const names = status.outstanding.map((t) => status.documents[t]?.title || t).join(' and ');

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="proslot-legal-title"
      style={{ position: 'fixed', inset: 0, zIndex: 2147483000, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
      <form onSubmit={accept} style={{ width: '100%', maxWidth: 420, background: '#fff', borderRadius: 16, padding: '28px 28px 22px', boxShadow: '0 20px 50px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 id="proslot-legal-title" style={{ margin: 0, textAlign: 'center', fontSize: 16, fontWeight: 700, color: C.ink }}>We've updated our terms</h2>
        <p style={{ margin: '-4px 0 4px', textAlign: 'center', fontSize: 13, color: C.soft }}>
          {`You can read the updated document${docs.length > 1 ? 's' : ''} below, then continue to ${appName}.`}
        </p>
        {docs.map((t) => (
          <a key={t} href={status.documents[t].url} target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 12, border: `2px solid ${C.line}`, textDecoration: 'none' }}>
            <span>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: C.ink }}>{status.documents[t].title}</span>
              <span style={{ display: 'block', fontSize: 11, color: C.soft, marginTop: 2 }}>Version {status.documents[t].version} · opens in a new tab</span>
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>Read →</span>
          </a>
        ))}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.45, color: C.text, marginTop: 2 }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I agree to the updated {names}. My account and data are managed by <strong>{appName}</strong> on the ProSlot platform.</span>
        </label>
        {error && <p role="alert" style={{ margin: 0, fontSize: 12, color: '#b91c1c' }}>{error}</p>}
        <button type="submit" disabled={saving || !agreed}
          style={{ width: '100%', padding: '11px 0', border: 0, borderRadius: 10, fontSize: 13, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: '#fff', background: `linear-gradient(135deg, ${C.green}, ${C.greenDark})`, opacity: saving || !agreed ? 0.5 : 1, cursor: saving || !agreed ? 'default' : 'pointer' }}>
          {saving ? 'Saving…' : 'Agree & Continue'}
        </button>
        {onSignOut && (
          <button type="button" onClick={() => { void onSignOut(); }}
            style={{ background: 'none', border: 0, fontSize: 12, fontWeight: 600, color: C.soft, cursor: 'pointer', textDecoration: 'underline' }}>
            Not now — sign out
          </button>
        )}
      </form>
    </div>
  );
}

export default LegalGate;
