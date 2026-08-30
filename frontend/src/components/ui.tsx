import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import type { PowerState } from '../lib/types';

// ---------------------------------------------------------------- Button ---

type Variant = 'primary' | 'default' | 'danger' | 'gold' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'mc-btn-primary',
  default: 'mc-btn-default',
  danger: 'mc-btn-danger',
  gold: 'mc-btn-gold',
  ghost: 'mc-btn-ghost',
};

export function Button({
  variant = 'default',
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={clsx(VARIANTS[variant], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ----------------------------------------------------------------- Panel ---

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  icon,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: ReactNode;
}) {
  return (
    <section className={clsx('mc-frame animate-fade-in', className)}>
      <span className="mc-frame-stud-light" />
      <span className="mc-frame-stud-dark" />
      <div className="mc-frame-inner">
        {(title || actions) && (
          <header className="mc-frame-head">
            <div className="flex items-center gap-2.5">
              {icon && <span className="text-grass-light">{icon}</span>}
              <div>
                <h2 className="heading text-[15px] leading-tight">{title}</h2>
                {subtitle && <p className="mt-1 text-xs text-stone-350">{subtitle}</p>}
              </div>
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </header>
        )}
        <div className={clsx('p-4', bodyClassName)}>{children}</div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- Badge ---

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'red' | 'gold' | 'blue' | 'purple';
  className?: string;
}) {
  const tones = {
    neutral: 'border-stone-600 bg-stone-700/60 text-stone-300',
    green: 'border-emerald/45 bg-emerald/[0.14] text-emerald',
    red: 'border-redstone/50 bg-redstone/[0.14] text-redstone',
    gold: 'border-gold/45 bg-gold/[0.14] text-gold',
    blue: 'border-diamond/40 bg-diamond/10 text-diamond',
    purple: 'border-lapis/60 bg-lapis/20 text-indigo-300',
  };
  return <span className={clsx('mc-badge', tones[tone], className)}>{children}</span>;
}

const STATE_META: Record<
  PowerState,
  { label: string; tone: 'green' | 'red' | 'gold' | 'neutral'; dot: string }
> = {
  // Der laufende Server bekommt einen pulsierenden Ring statt eines starren Punkts.
  running: { label: 'Online', tone: 'green', dot: 'bg-emerald animate-ring' },
  starting: { label: 'Startet', tone: 'gold', dot: 'bg-gold animate-pulse-soft' },
  stopped: { label: 'Offline', tone: 'neutral', dot: 'bg-stone-500' },
  missing: { label: 'Kein Container', tone: 'neutral', dot: 'bg-stone-600' },
  error: { label: 'Fehler', tone: 'red', dot: 'bg-redstone animate-pulse-soft' },
};

export function StateBadge({ state, className }: { state: PowerState; className?: string }) {
  const meta = STATE_META[state] ?? STATE_META.stopped;
  return (
    <Badge tone={meta.tone} className={className}>
      <span className={clsx('h-[7px] w-[7px] shrink-0', meta.dot)} />
      {meta.label}
    </Badge>
  );
}

// ---------------------------------------------------------------- Progress --

export function ProgressBar({
  value,
  tone = 'green',
  className,
  showLabel,
}: {
  value: number;
  tone?: 'green' | 'gold' | 'red' | 'blue';
  className?: string;
  showLabel?: boolean;
}) {
  const tones = {
    green: '#7FB238',
    gold: '#FFAA00',
    red: '#E8453C',
    blue: '#4AEDD9',
  };
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="mc-well h-2.5 flex-1 overflow-hidden">
        <div
          className="h-full"
          style={{
            width: `${pct}%`,
            background: tones[tone],
            boxShadow: `0 0 12px ${tones[tone]}66`,
            transition: 'width .7s cubic-bezier(.2,.8,.2,1)',
          }}
        />
      </div>
      {showLabel && (
        <span className="w-10 shrink-0 text-right font-mono text-[11px] text-stone-350">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- Modal ---

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className={clsx('mc-frame relative z-10 w-full animate-pop-in', sizes[size])}>
        <div className="mc-frame-inner">
          <div className="grass-strip-thin h-1.5 w-full" />
          <header className="mc-frame-head !justify-between">
            <h2 className="heading text-[15px]">{title}</h2>
            <button
              onClick={onClose}
              className="text-stone-400 transition hover:text-white"
              aria-label="Schließen"
            >
              <X size={18} />
            </button>
          </header>
          <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-stone-890 bg-stone-well/60 px-4 py-3">
              {footer}
            </footer>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Bestätigen',
  danger,
  requireText,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => unknown;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const blocked = Boolean(requireText) && typed !== requireText;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={blocked}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-stone-300">
        <div>{message}</div>
        {requireText && (
          <div>
            <label className="mc-label">
              Tippe <span className="text-redstone">{requireText}</span> zum Bestätigen
            </label>
            <input
              className="mc-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- Toast ---

interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

const ToastContext = createContext<{
  push: (kind: Toast['kind'], message: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  const icons = {
    success: <CheckCircle2 size={18} className="text-emerald" />,
    error: <XCircle size={18} className="text-redstone" />,
    info: <Info size={18} className="text-diamond" />,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Mobil: links+rechts verankert statt fester Breite, sonst ragt er aus dem Viewport */}
      <div className="pointer-events-none fixed bottom-4 left-4 right-4 z-[60] flex flex-col gap-2 sm:left-auto sm:w-full sm:max-w-sm">
        {toasts.map((t) => (
          <div key={t.id} className="mc-frame pointer-events-auto animate-pop-in !p-[3px]">
            <div className="mc-frame-inner flex items-start gap-3 p-3 text-sm">
              <span className="mt-0.5 shrink-0">{icons[t.kind]}</span>
              <p className="flex-1 leading-snug text-stone-100">{t.message}</p>
              <button
                onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
                className="shrink-0 text-stone-450 hover:text-stone-100"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast benötigt <ToastProvider>');
  return {
    success: (m: string) => ctx.push('success', m),
    error: (m: string) => ctx.push('error', m),
    info: (m: string) => ctx.push('info', m),
  };
}

// ------------------------------------------------------------- Sonstiges ---

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin text-grass-light', className)} size={20} />;
}

export function LoadingBlock({ label = 'Lädt …' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-stone-400">
      <Spinner />
      {label}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-stone-600">{icon}</div>}
      <h3 className="heading text-base text-stone-200">{title}</h3>
      {description && <p className="max-w-md text-sm text-stone-400">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 border border-redstone/40 bg-redstone/10 p-3 text-sm text-red-200">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-redstone" />
      <div>{children}</div>
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 border border-diamond/30 bg-diamond/10 p-3 text-sm text-cyan-100">
      <Info size={16} className="mt-0.5 shrink-0 text-diamond" />
      <div>{children}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mc-label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-stone-450">{hint}</p>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-left disabled:opacity-50"
    >
      <span
        className={clsx(
          'relative h-6 w-11 shrink-0 border transition-colors',
          checked ? 'border-grass-dark bg-grass' : 'border-stone-600 bg-stone-700',
        )}
      >
        <span
          className={clsx(
            'absolute top-[2px] h-[18px] w-[18px] bg-stone-100 transition-all',
            checked ? 'left-[24px]' : 'left-[2px]',
          )}
        />
      </span>
      {label && <span className="text-sm text-stone-200">{label}</span>}
    </button>
  );
}
