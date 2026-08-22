/**
 * @proslot/sso-kit — <OnboardingFlow />
 *
 * A step-runner shell replacing the near-identical ~363-line Onboarding.tsx
 * pages (NYHC and TCBlackhawks differ by 12 lines after brand-stripping).
 *
 * The shell owns what every site does the same way: ordered steps, progress,
 * back/next, per-step validation, shared draft state, and completion. Sites
 * supply their OWN step array — that is where legitimate per-site difference
 * lives, instead of a forked copy of the whole flow.
 *
 *   <OnboardingFlow
 *     steps={[profileStep, roleStep, waiverStep, myCustomStep]}
 *     onComplete={async (data) => { ... }}
 *   />
 */

import React, { useMemo, useState } from 'react';

export interface OnboardingStepContext<T = Record<string, any>> {
  data: T;
  setData: (patch: Partial<T>) => void;
  /** Role resolved at sign-in — steps commonly branch on this. */
  role?: string;
  orgId?: string;
}

export interface OnboardingStep<T = Record<string, any>> {
  id: string;
  title: string;
  subtitle?: string;
  /** Skip conditionally, e.g. only ask guardian info when role is PARENT. */
  when?: (ctx: OnboardingStepContext<T>) => boolean;
  /** Return an error string to block advancing, or null/undefined to allow. */
  validate?: (ctx: OnboardingStepContext<T>) => string | null | undefined;
  render: (ctx: OnboardingStepContext<T>) => React.ReactNode;
}

export interface OnboardingFlowProps<T = Record<string, any>> {
  steps: OnboardingStep<T>[];
  initialData?: T;
  role?: string;
  orgId?: string;
  onComplete: (data: T) => Promise<void> | void;
  onCancel?: () => void;
  /** Rendered above the steps — logo/brand header. */
  header?: React.ReactNode;
  submitLabel?: string;
}

export function OnboardingFlow<T extends Record<string, any> = Record<string, any>>({
  steps, initialData, role, orgId, onComplete, onCancel, header, submitLabel = 'Finish',
}: OnboardingFlowProps<T>) {
  const [data, setDataState] = useState<T>((initialData ?? {}) as T);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const setData = (patch: Partial<T>) => setDataState((d) => ({ ...d, ...patch }));
  const ctx: OnboardingStepContext<T> = { data, setData, role, orgId };

  // Steps whose `when` currently passes. Recomputed as data changes, so a
  // role chosen in step 1 can reveal/hide later steps.
  const active = useMemo(() => steps.filter((s) => (s.when ? s.when(ctx) : true)), [steps, data, role, orgId]);
  const step = active[Math.min(index, active.length - 1)];
  const isLast = index >= active.length - 1;

  if (!step) return null;

  const next = async () => {
    const err = step.validate?.(ctx);
    if (err) { setError(err); return; }
    setError('');
    if (!isLast) { setIndex((i) => i + 1); return; }
    setSubmitting(true);
    try {
      await onComplete(data);
    } catch (e: any) {
      setError(e?.message || 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  const back = () => { setError(''); index === 0 ? onCancel?.() : setIndex((i) => i - 1); };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        {header}
        <div style={S.progressTrack} role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={active.length}>
          <div style={{ ...S.progressFill, width: `${((index + 1) / active.length) * 100}%` }} />
        </div>
        <p style={S.stepCount}>Step {index + 1} of {active.length}</p>

        <h2 style={S.title}>{step.title}</h2>
        {step.subtitle && <p style={S.subtitle}>{step.subtitle}</p>}

        <div style={S.body}>{step.render(ctx)}</div>

        {error && <p style={S.error} role="alert">{error}</p>}

        <div style={S.actions}>
          {(index > 0 || onCancel) && (
            <button type="button" onClick={back} disabled={submitting} style={S.secondary}>
              {index === 0 ? 'Cancel' : 'Back'}
            </button>
          )}
          <button type="button" onClick={next} disabled={submitting} style={S.primary}>
            {submitting ? 'Saving…' : isLast ? submitLabel : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 520 },
  progressTrack: { height: 4, background: 'rgba(148,163,184,0.2)', borderRadius: 999, overflow: 'hidden', margin: '16px 0 8px' },
  progressFill: { height: '100%', background: '#10B981', transition: 'width 200ms ease' },
  stepCount: { fontSize: 12, opacity: 0.7, margin: '0 0 16px' },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 4px' },
  subtitle: { fontSize: 14, opacity: 0.75, margin: '0 0 16px' },
  body: { margin: '16px 0' },
  error: { color: '#DC2626', fontSize: 14, margin: '8px 0 0' },
  actions: { display: 'flex', gap: 12, marginTop: 24 },
  secondary: { flex: '0 0 auto', padding: '12px 20px', borderRadius: 12, border: '1px solid rgba(148,163,184,0.4)', background: 'transparent', cursor: 'pointer', fontWeight: 600 },
  primary: { flex: 1, padding: '12px 20px', borderRadius: 12, border: 'none', background: 'linear-gradient(135deg,#10B981,#059669)', color: '#FFF', fontWeight: 700, cursor: 'pointer' },
};

export default OnboardingFlow;
