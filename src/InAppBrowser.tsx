/**
 * @proslotbosllc/sso-kit — <InAppBrowserNotice /> and in-app browser detection.
 *
 * Asks a person to open the site in Chrome or Safari before signing in when
 * they are inside Instagram's, Facebook's or another app's built-in browser.
 * TC Black Hawks, 28–30 Oct 2026: parents tapping the Instagram bio link
 * (Tracer 22ed329ed986077a) were refused by App Check, because reCAPTCHA
 * scores those browsers low, and Google sign-in refuses embedded browsers
 * outright. Once App Check is enforced they could not sign in or book there.
 *
 * Opt-in. initiateSSO behaves exactly as before until a site mounts the
 * notice; while it is mounted, a sign-in started in an in-app browser shows
 * the notice instead of leaving for the hub. "Continue here" carries on with
 * that same sign-in, so nobody is ever stuck behind it.
 *
 *   // near the site's root, once
 *   <InAppBrowserNotice />
 *
 * Styles are inline, so it renders the same whatever CSS the site uses.
 */

import React, { useState, useSyncExternalStore } from 'react';

export type InAppBrowserApp =
  | 'Instagram' | 'Facebook' | 'Messenger' | 'TikTok' | 'Snapchat' | 'LinkedIn' | 'LINE';

export interface InAppBrowser {
  app: InAppBrowserApp;
  platform: 'android' | 'ios' | 'other';
}

// Order matters: Instagram and Messenger also carry Facebook's FBAN/FBAV tokens.
const APPS: Array<[InAppBrowserApp, RegExp]> = [
  ['Instagram', /\bInstagram\b/i],
  ['Messenger', /\b(FB_IAB\/MESSENGER|MessengerForiOS|Orca-Android)\b/i],
  ['Facebook', /\b(FBAN|FBAV|FB_IAB|FBIOS|FB4A)\b/],
  ['TikTok', /\b(musical_ly|BytedanceWebview|TikTok)\b/i],
  ['Snapchat', /\bSnapchat\b/i],
  ['LinkedIn', /\bLinkedInApp\b/i],
  ['LINE', /\bLine\/\d/],
];

/** The app whose built-in browser this is, or null for a real browser. */
export function detectInAppBrowser(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): InAppBrowser | null {
  const hit = APPS.find(([, pattern]) => pattern.test(ua));
  if (!hit) return null;
  const platform = /Android/i.test(ua) ? 'android' : /iPhone|iPad|iPod/i.test(ua) ? 'ios' : 'other';
  return { app: hit[0], platform };
}

/**
 * An Android intent link that opens `url` in Chrome, falling back to the
 * normal page if Chrome is missing. Only http(s) pages are turned into one.
 */
export function chromeIntentUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const rest = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  const scheme = parsed.protocol.slice(0, -1);
  return `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

// ---- the hand-off between initiateSSO and a mounted notice ---------------

type Pending = { browser: InAppBrowser; proceed: () => void };

let mounted = 0;
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * @internal Called by initiateSSO. True when it should stop and let the notice
 * take over; `proceed` resumes the same sign-in if the person continues here.
 */
export function interceptInAppSignIn(proceed: () => void, ua?: string): boolean {
  if (mounted === 0) return false;
  const browser = detectInAppBrowser(ua);
  if (!browser) return false;
  pending = { browser, proceed };
  emit();
  return true;
}

/** @internal For tests and the notice: the sign-in waiting on the person, if any. */
export function pendingInAppSignIn(): Pending | null {
  return pending;
}

/** @internal Mark a notice mounted; returns the unmount. */
export function registerInAppNotice(): () => void {
  mounted += 1;
  return () => {
    mounted = Math.max(0, mounted - 1);
    if (mounted === 0 && pending) { pending = null; emit(); }
  };
}

function settle(): Pending | null {
  const was = pending;
  pending = null;
  emit();
  return was;
}

// ---- the notice ----------------------------------------------------------

export interface InAppBrowserNoticeProps {
  /** Button colour. Default near-black. */
  accent?: string;
}

const C = { ink: '#121211', soft: '#6b675d', line: '#e8e4dc' };

export function InAppBrowserNotice({ accent = C.ink }: InAppBrowserNoticeProps) {
  React.useEffect(() => registerInAppNotice(), []);
  const current = useSyncExternalStore(subscribe, pendingInAppSignIn, () => null);
  const [copied, setCopied] = useState(false);
  if (!current) return null;

  const { app, platform } = current.browser;
  const here = typeof window !== 'undefined' ? window.location.href : '';
  const intent = platform === 'android' ? chromeIntentUrl(here) : null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(here);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const continueHere = () => {
    const was = settle();
    was?.proceed();
  };

  const button = { minHeight: 44, padding: '0 16px', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer' } as const;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sso-in-app-title"
      data-testid="in-app-browser"
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))', background: 'rgba(18,18,17,.45)',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div style={{ width: '100%', maxWidth: 460, boxSizing: 'border-box', padding: 20, borderRadius: 14, background: '#fff', boxShadow: '0 12px 32px rgba(18,18,17,.25)' }}>
        <p id="sso-in-app-title" style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.ink }}>
          Open this page in your browser to sign in
        </p>
        <p style={{ margin: '6px 0 0', fontSize: 15, lineHeight: 1.5, color: C.soft }}>
          {app}'s built-in browser can't always complete sign-in.{' '}
          {platform === 'ios'
            ? `Tap the ••• menu in ${app} and choose Open in browser, or copy the link into Safari.`
            : platform === 'android'
              ? 'Open it in Chrome and sign in there.'
              : 'Copy the link into your usual browser and sign in there.'}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          {intent ? (
            <a
              href={intent}
              data-testid="in-app-open-chrome"
              style={{ ...button, display: 'flex', alignItems: 'center', justifyContent: 'center', background: accent, color: '#fff', textDecoration: 'none' }}
            >
              Open in Chrome
            </a>
          ) : null}
          <button
            type="button"
            data-testid="in-app-copy"
            onClick={() => { void copyLink(); }}
            style={{ ...button, border: intent ? `1px solid ${C.line}` : 0, background: intent ? '#fff' : accent, color: intent ? C.ink : '#fff' }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <button
            type="button"
            data-testid="in-app-continue"
            onClick={continueHere}
            style={{ ...button, border: 0, background: 'transparent', color: C.soft, fontWeight: 600 }}
          >
            Continue here
          </button>
        </div>
      </div>
    </div>
  );
}
