/**
 * Settings → Import from Stremio: sign in, see what the account holds, choose
 * what to bring over, import it, and see what happened.
 *
 * The sign-in goes straight to the core (`stremioCommands.fetch`) and is
 * cleared from this component as soon as it is sent. Every step works with
 * the keys alone: each one moves focus to its main control.
 */
import { Button, buttonVariants } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { Check, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';

import { addonsStore } from '@/features/addons/addons-store';
import { Group, Section, Segmented } from '@/features/settings/settings-controls';
import { settingElementId, settingsSection } from '@/features/settings/settings-sections';
import {
  addonCounts,
  addonTotals,
  addonsDetail,
  plural,
  previewHeadline,
  runImport,
  type ImportBackend,
  type ImportChoice,
  type ImportReport,
  type ImportStage,
} from '@/features/stremio-import/stremio-import';
import {
  describeError,
  stremioCommands,
  type ImportCounts,
  type StremioImportPreview,
  type StremioSignIn,
} from '@/services/native';

type Step =
  | { kind: 'signIn'; error: string | null }
  | { kind: 'reading' }
  | { kind: 'preview'; preview: StremioImportPreview }
  | { kind: 'importing'; stage: ImportStage | null }
  | { kind: 'done'; report: ImportReport };

const backend: ImportBackend = {
  installAddon: (transportUrl) => addonsStore.getState().install(transportUrl),
  installedUrls: () => addonsStore.getState().installed.map((addon) => addon.transportUrl),
  importLibrary: stremioCommands.importLibrary,
  discard: stremioCommands.discard,
};

/** Lets the core forget the account it read. */
function discard() {
  void stremioCommands.discard().catch(() => {});
}

const SECTION = settingsSection('import');

export function StremioImportSection() {
  const [step, setStep] = useState<Step>({ kind: 'signIn', error: null });
  const stepRef = useRef(step);
  const mounted = useRef(true);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // Leaving Settings with an account read (or being read) but not imported:
  // let the core forget it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (stepRef.current.kind === 'preview') discard();
    };
  }, []);

  const restart = () => setStep({ kind: 'signIn', error: null });

  return (
    <Section title={SECTION.title} description={SECTION.description}>
      <Group title="Stremio">
        <div id={settingElementId('stremio')} className="px-5 py-4">
          {step.kind === 'signIn' && (
            <SignInStep
              error={step.error}
              onSubmit={(signIn) => {
                setStep({ kind: 'reading' });
                stremioCommands.fetch(signIn).then(
                  (preview) => {
                    if (mounted.current) setStep({ kind: 'preview', preview });
                    else discard();
                  },
                  (error: unknown) => setStep({ kind: 'signIn', error: describeError(error) }),
                );
              }}
            />
          )}
          {step.kind === 'reading' && <Busy label="Reading your Stremio account…" />}
          {step.kind === 'preview' && (
            <PreviewStep
              preview={step.preview}
              onCancel={() => {
                discard();
                restart();
              }}
              onImport={(choice) => {
                setStep({ kind: 'importing', stage: null });
                // Addons install into a loaded list, after what's there.
                void addonsStore
                  .getState()
                  .load()
                  .then(() =>
                    runImport(step.preview, choice, backend, (stage) =>
                      setStep({ kind: 'importing', stage }),
                    ),
                  )
                  .then((report) => setStep({ kind: 'done', report }));
              }}
            />
          )}
          {step.kind === 'importing' && <ImportingStep stage={step.stage} />}
          {step.kind === 'done' && <DoneStep report={step.report} onDone={restart} />}
        </div>
      </Group>
    </Section>
  );
}

/** Focuses `ref` once, when the step it belongs to appears. */
function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

const FIELD =
  'h-11 w-full min-w-0 rounded-full border border-white/10 bg-ink-950/50 px-5 text-sm text-ink-100 placeholder:text-ink-500 focus-visible:border-accent/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

type Method = 'authKey' | 'password';

function SignInStep({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: (signIn: StremioSignIn) => void;
}) {
  const [method, setMethod] = useState<Method>('authKey');
  const [authKey, setAuthKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const methodId = useId();
  const keyId = useId();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  // Back from a failed sign-in: straight to the field to fix.
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error) firstField.current?.focus();
  }, [error]);

  const ready =
    method === 'authKey' ? authKey.trim() !== '' : email.trim() !== '' && password !== '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const signIn: StremioSignIn =
      method === 'authKey'
        ? { method, authKey: authKey.trim() }
        : { method, email: email.trim(), password };
    // Not kept here once sent.
    setAuthKey('');
    setPassword('');
    onSubmit(signIn);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p id={methodId} className="text-sm font-medium text-ink-100">
          Sign in with
        </p>
        <Segmented
          labelledBy={methodId}
          options={[
            { value: 'authKey', label: 'Auth key' },
            { value: 'password', label: 'Email and password' },
          ]}
          value={method}
          onChange={setMethod}
        />
      </div>

      {method === 'authKey' ? (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-ink-300">
            <li>
              In a browser, sign in at <span className="text-ink-100">web.stremio.com</span>.
            </li>
            <li>
              Open the developer tools (F12, or ⌥⌘I on a Mac), then{' '}
              <span className="text-ink-100">Application</span> (Safari:{' '}
              <span className="text-ink-100">Storage</span>) →{' '}
              <span className="text-ink-100">Local storage</span> → web.stremio.com.
            </li>
            <li>
              Select <span className="text-ink-100">profile</span> and copy the value of{' '}
              <span className="text-ink-100">auth → key</span>, without the quotes.
            </li>
          </ol>
          <label htmlFor={keyId} className="block text-sm font-medium text-ink-100">
            Auth key
          </label>
          <input
            ref={firstField}
            id={keyId}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={authKey}
            onChange={(event) => setAuthKey(event.target.value)}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            className={FIELD}
          />
          <p className="text-xs leading-relaxed text-ink-400">
            Kiro never sees your password this way. It uses the key once to read your account,
            doesn’t keep it, and leaves you signed in on the web.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={emailId} className="block text-sm font-medium text-ink-100">
                Email
              </label>
              <input
                ref={firstField}
                id={emailId}
                type="email"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-describedby={error ? errorId : undefined}
                aria-invalid={error ? true : undefined}
                className={FIELD}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={passwordId} className="block text-sm font-medium text-ink-100">
                Password
              </label>
              <input
                id={passwordId}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={error ? errorId : undefined}
                aria-invalid={error ? true : undefined}
                className={FIELD}
              />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-ink-400">
            Sent straight to Stremio over a secure connection and used once, to read your account.
            Kiro doesn’t keep them, and signs that session out when it’s done.
          </p>
        </div>
      )}

      {error && (
        <p id={errorId} role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!ready}>
        Continue
      </Button>
    </form>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 py-2 text-sm text-ink-300">
      <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </p>
  );
}

function PreviewStep({
  preview,
  onImport,
  onCancel,
}: {
  preview: StremioImportPreview;
  onImport: (choice: ImportChoice) => void;
  onCancel: () => void;
}) {
  const newAddons = addonCounts(preview).new;
  const [choice, setChoice] = useState<ImportChoice>({
    addons: newAddons > 0,
    libraryItems: preview.libraryItems > 0,
    progress: preview.watched > 0,
  });
  const importButton = useFocusOnMount<HTMLButtonElement>();
  const headingId = useId();
  const anything = choice.addons || choice.libraryItems || choice.progress;
  const newNames = preview.addons
    .filter((addon) => addon.status === 'new')
    .map((addon) => addon.name);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-ink-400">Your Stremio account has</p>
        <p id={headingId} className="mt-0.5 text-base font-semibold text-ink-50">
          {previewHeadline(preview)}
        </p>
      </div>
      <ul aria-labelledby={headingId} className="space-y-2">
        <ChoiceRow
          label="Addons"
          detail={addonsDetail(preview)}
          extra={newNames.length > 0 ? newNames.join(', ') : undefined}
          checked={choice.addons}
          disabled={newAddons === 0}
          onChange={(addons) => setChoice({ ...choice, addons })}
        />
        <ChoiceRow
          label="Library"
          detail={`${plural(preview.libraryItems, 'title')}, added to your watchlist. Titles already on it stay as they are.`}
          checked={choice.libraryItems}
          disabled={preview.libraryItems === 0}
          onChange={(libraryItems) => setChoice({ ...choice, libraryItems })}
        />
        <ChoiceRow
          label="Watch progress"
          detail={`${plural(preview.watched, 'title')} watched, ${preview.inProgress.toLocaleString()} to carry on with in Continue watching. Anything you’ve watched in Kiro since is kept.`}
          checked={choice.progress}
          disabled={preview.watched === 0}
          onChange={(progress) => setChoice({ ...choice, progress })}
        />
      </ul>
      {preview.skipped > 0 && (
        <p className="text-xs text-ink-400">
          {plural(preview.skipped, 'library item')} can’t be imported: removed from your library, or
          nothing Kiro can show.
        </p>
      )}
      {/* Arriving from the choices lands on Import, not the nearer Cancel. */}
      <div data-nav-group className="flex gap-2">
        <button
          ref={importButton}
          data-nav-start
          type="button"
          disabled={!anything}
          onClick={() => onImport(choice)}
          className={buttonVariants()}
        >
          Import
        </button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A checkbox with its label and what choosing it does. */
function ChoiceRow({
  label,
  detail,
  extra,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  extra?: string | undefined;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const detailId = useId();
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked && !disabled}
        aria-labelledby={labelId}
        aria-describedby={detailId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="flex w-full cursor-pointer items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-left transition-colors hover:border-white/15 hover:bg-white/[0.04] focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden
          className={cx(
            'mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-md border transition-colors',
            checked && !disabled ? 'border-accent bg-accent text-white' : 'border-white/25',
          )}
        >
          {checked && !disabled && <Check className="size-3.5" strokeWidth={3} />}
        </span>
        <span className="min-w-0">
          <span id={labelId} className="block text-sm font-medium text-ink-50">
            {label}
          </span>
          <span id={detailId} className="mt-0.5 block text-xs leading-relaxed text-ink-400">
            {detail}
            {extra && <span className="mt-1 line-clamp-2 block text-ink-500">{extra}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function ImportingStep({ stage }: { stage: ImportStage | null }) {
  const status =
    stage?.kind === 'addons'
      ? `Adding addons (${stage.done + 1} of ${stage.total}): ${stage.current}`
      : 'Importing your library…';
  const percent =
    stage?.kind === 'addons' && stage.total > 0
      ? Math.round((stage.done / stage.total) * 100)
      : null;
  return (
    <div className="space-y-3">
      <Busy label={status} />
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]"
      >
        <div
          className={cx(
            'h-full rounded-full bg-accent transition-[width] duration-300',
            percent === null && 'w-1/3 animate-pulse',
          )}
          style={percent === null ? undefined : { width: `${Math.max(percent, 4)}%` }}
        />
      </div>
    </div>
  );
}

function DoneStep({ report, onDone }: { report: ImportReport; onDone: () => void }) {
  const doneButton = useFocusOnMount<HTMLButtonElement>();
  const totals = report.addons ? addonTotals(report.addons) : null;
  const problems =
    report.libraryError !== null ||
    (totals?.failed ?? 0) > 0 ||
    (report.library?.libraryItems?.failed ?? 0) > 0;

  return (
    <div className="space-y-4">
      <p role="status" className="text-base font-semibold text-ink-50">
        {problems ? 'Imported, with a few problems' : 'Import finished'}
      </p>
      <dl className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.07]">
        {report.addons && totals && (
          <SummaryRow label="Addons">
            {counts([
              [totals.added, 'added'],
              [totals.skipped, 'skipped'],
              [totals.failed, 'failed'],
            ])}
            {report.addons.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer rounded text-xs text-ink-300 hover:text-ink-50 focus-visible:focus-ring">
                  Each addon
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {report.addons.map((addon) => (
                    <li key={addon.transportUrl} className="text-xs">
                      <span className="text-ink-100">{addon.name}</span>{' '}
                      <span
                        className={cx(addon.result === 'failed' ? 'text-red-300' : 'text-ink-400')}
                      >
                        {addon.result}
                        {addon.reason && `: ${addon.reason}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </SummaryRow>
        )}
        {report.library?.libraryItems && (
          <SummaryRow label="Library">
            {libraryCounts(report.library.libraryItems, {
              added: 'added to your watchlist',
              skipped: 'already on it',
              failed: 'not added: your watchlist is full',
            })}
          </SummaryRow>
        )}
        {report.library?.progress && (
          <SummaryRow label="Watch progress">
            {libraryCounts(report.library.progress, {
              added: 'added',
              updated: 'updated',
              skipped: 'kept as they were (Kiro’s was newer)',
            })}
          </SummaryRow>
        )}
        {report.libraryError && (
          <SummaryRow label="Library">
            <span className="text-red-300">Couldn’t import it. {report.libraryError}</span>
          </SummaryRow>
        )}
      </dl>
      <div data-nav-group className="flex gap-2">
        <button
          ref={doneButton}
          data-nav-start
          type="button"
          onClick={onDone}
          className={buttonVariants()}
        >
          Done
        </button>
        {report.library && (
          <Link to="/library" className={buttonVariants({ variant: 'secondary' })}>
            Open Library
          </Link>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3 text-sm">
      <dt className="w-32 shrink-0 text-ink-400">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-100">{children}</dd>
    </div>
  );
}

/** `2 added · 1 skipped`, leaving out zeros (but never empty). */
function counts(parts: [count: number, label: string][]): string {
  const shown = parts.filter(([count]) => count > 0);
  return (shown.length > 0 ? shown : parts.slice(0, 1))
    .map(([count, label]) => `${count.toLocaleString()} ${label}`)
    .join(' · ');
}

function libraryCounts(
  importCounts: ImportCounts,
  labels: Partial<Record<keyof ImportCounts, string>>,
): string {
  return counts(
    (Object.keys(labels) as (keyof ImportCounts)[]).map((key) => [
      importCounts[key],
      labels[key] ?? key,
    ]),
  );
}
