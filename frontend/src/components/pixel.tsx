import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Grasnarbe
// ---------------------------------------------------------------------------

/** Zierleiste am oberen Rand – Halm, Gras, Erde mit Pixelkerben. */
export function GrassStrip({ thin, className }: { thin?: boolean; className?: string }) {
  return (
    <div
      className={clsx(thin ? 'grass-strip-thin h-2' : 'grass-strip h-3.5', 'w-full', className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Blocksymbol
// ---------------------------------------------------------------------------

/**
 * Ein Minecraft-Block als Symbol: farbiger Würfel mit hellem Deckel,
 * Schlagschatten nach unten und einem Icon in der Mitte.
 */
export function BlockIcon({
  size = 52,
  color = '#5B8731',
  icon,
  imageUrl,
  grass,
  bob,
  className,
}: {
  size?: number;
  color?: string;
  icon?: ReactNode;
  /** Modpack-Bild statt Farbfläche. */
  imageUrl?: string | null;
  /** Erdblock mit Grasdecke (Logo). */
  grass?: boolean;
  bob?: boolean;
  className?: string;
}) {
  const capHeight = Math.max(6, Math.round(size * 0.19));

  if (imageUrl) {
    return (
      <span
        className={clsx('relative block shrink-0 overflow-hidden border border-stone-950', className)}
        style={{ width: size, height: size, boxShadow: '0 4px 0 0 rgba(0,0,0,.5)' }}
      >
        <img src={imageUrl} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }

  return (
    <span
      className={clsx('relative block shrink-0 border border-stone-950', bob && 'animate-bob', className)}
      style={{
        width: size,
        height: size,
        background: grass ? '#866043' : color,
        backgroundImage:
          'repeating-linear-gradient(45deg, rgba(0,0,0,.12) 0 4px, transparent 4px 8px)',
        boxShadow: '0 4px 0 0 rgba(0,0,0,.5), inset -2px -2px 0 rgba(0,0,0,.32)',
      }}
    >
      {grass ? (
        <>
          <span
            className="absolute inset-x-0 top-0"
            style={{ height: capHeight, background: '#5B8731', borderBottom: '2px solid #3F5F22' }}
          />
          <span
            className="absolute inset-x-0 top-0"
            style={{ height: Math.max(3, Math.round(capHeight * 0.32)), background: '#7FB238' }}
          />
        </>
      ) : (
        <span
          className="absolute inset-x-0 top-0"
          style={{ height: capHeight, background: 'rgba(255,255,255,.28)' }}
        />
      )}

      {icon && (
        <span
          className="absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center text-white"
          style={{ top: '58%' }}
        >
          {icon}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Balkendiagramm
// ---------------------------------------------------------------------------

/**
 * Verlauf als Pixelbalken. Ältere Werte sind blasser, damit die Leserichtung
 * klar ist. Werte sind Prozent (0–100).
 */
export function BarChart({
  values,
  color,
  height = 30,
  glow,
  gridlines,
  className,
}: {
  values: number[];
  color: string;
  height?: number;
  glow?: boolean;
  gridlines?: boolean;
  className?: string;
}) {
  const last = Math.max(1, values.length - 1);

  return (
    <div
      className={clsx('mc-well flex items-end', className)}
      style={{
        height,
        gap: gridlines ? 3 : 2,
        padding: gridlines ? 4 : 2,
        backgroundImage: gridlines
          ? 'repeating-linear-gradient(0deg, rgba(255,255,255,.03) 0 1px, transparent 1px 24px)'
          : undefined,
      }}
    >
      {values.map((value, i) => (
        <span
          key={i}
          className="flex-1 transition-[height] duration-500 ease-out"
          style={{
            background: color,
            opacity: 0.35 + 0.65 * (i / last),
            height: `${Math.max(3, Math.min(100, value))}%`,
            boxShadow: glow ? `0 0 8px ${color}4d` : undefined,
          }}
        />
      ))}
    </div>
  );
}

/** Einzelner Fortschrittsbalken im Schienen-Look. */
export function PixelBar({
  percent,
  color = '#7FB238',
  height = 10,
  glow,
  striped,
  className,
}: {
  percent: number;
  color?: string;
  height?: number;
  glow?: boolean;
  striped?: boolean;
  className?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));

  return (
    <div className={clsx('mc-well overflow-hidden', className)} style={{ height }}>
      <div
        className={clsx('h-full', striped && 'animate-stripe')}
        style={{
          width: `${value}%`,
          background: striped ? undefined : color,
          backgroundImage: striped
            ? `repeating-linear-gradient(45deg, ${color} 0 7px, #c98700 7px 14px)`
            : undefined,
          backgroundSize: striped ? '28px 100%' : undefined,
          boxShadow: glow ? `0 0 12px ${color}8c` : undefined,
          transition: 'width .7s cubic-bezier(.2,.8,.2,1)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spielerkopf
// ---------------------------------------------------------------------------

const HEAD_COLORS = ['#866043', '#A97A55', '#E8453C', '#3C44AA', '#4AEDD9', '#FFAA00', '#5B8731'];

/** Pixelkopf mit zwei Augen – Ersatz für ein Skin-Bild, ohne Fremdanfrage. */
export function PixelHead({ name, size = 26 }: { name: string; size?: number }) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const color = HEAD_COLORS[hash % HEAD_COLORS.length];
  const eye = Math.max(3, Math.round(size * 0.15));

  return (
    <span
      className="relative shrink-0 border border-stone-950"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.22), inset -1px -1px 0 rgba(0,0,0,.4)',
      }}
      title={name}
    >
      <span
        className="absolute"
        style={{ left: size * 0.19, top: size * 0.35, width: eye, height: eye, background: 'rgba(0,0,0,.55)' }}
      />
      <span
        className="absolute"
        style={{ right: size * 0.19, top: size * 0.35, width: eye, height: eye, background: 'rgba(0,0,0,.55)' }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Ladeplatzhalter
// ---------------------------------------------------------------------------

export function SkeletonBar({ width, height = 12 }: { width?: string; height?: number }) {
  return <div className="skeleton" style={{ width: width ?? '100%', height }} />;
}

/** Platzhalterkarte in derselben Silhouette wie eine Serverkarte. */
export function SkeletonServerCard() {
  return (
    <div className="mc-frame">
      <div className="mc-frame-inner flex flex-col gap-3.5 p-4">
        <div className="flex items-center gap-3.5">
          <div className="skeleton h-[52px] w-[52px]" />
          <div className="flex flex-1 flex-col gap-2">
            <SkeletonBar width="58%" height={14} />
            <SkeletonBar width="38%" height={10} />
          </div>
        </div>
        <SkeletonBar height={44} />
        <SkeletonBar height={26} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schwebende Partikel (Anmeldeseite)
// ---------------------------------------------------------------------------

const MOTE_COLORS = ['#5B8731', '#866043', '#3b3b43', '#7FB238'];

/** Langsam aufsteigende Pixelblöcke im Hintergrund. */
export function Motes({ count = 14 }: { count?: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: count }, (_, i) => {
        const size = 5 + (i % 4) * 3;
        return (
          <span
            key={i}
            className="absolute"
            style={{
              bottom: -40,
              left: `${(i * 7.3 + 3) % 96}%`,
              width: size,
              height: size,
              background: MOTE_COLORS[i % MOTE_COLORS.length],
              boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.25), inset -1px -1px 0 rgba(0,0,0,.4)',
              animation: `float ${13 + (i % 5) * 3}s linear ${(i * 1.15).toFixed(1)}s infinite`,
            }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hilfsmittel
// ---------------------------------------------------------------------------

/**
 * Führt einen gleitenden Verlauf über die letzten `length` Messwerte.
 * Bis genug Daten da sind, wird mit dem ersten Wert aufgefüllt.
 */
export function useHistory(value: number | null | undefined, length = 20): number[] {
  const [history, setHistory] = useState<number[]>(() => Array(length).fill(2));
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    if (value === null || value === undefined) return;
    const rounded = Math.round(value * 10) / 10;
    if (lastRef.current === rounded) return;
    lastRef.current = rounded;
    setHistory((prev) => [...prev.slice(1), Math.max(2, Math.min(100, rounded))]);
  }, [value]);

  useEffect(() => {
    setHistory((prev) => (prev.length === length ? prev : Array(length).fill(2)));
  }, [length]);

  return history;
}

/** Zählt einen Wert beim ersten Anzeigen weich hoch. */
export function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(0);
  const startedFor = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    // Nur beim ersten sinnvollen Wert animieren, danach direkt folgen.
    if (startedFor.current !== null) {
      setValue(target);
      return;
    }
    startedFor.current = target;

    const start = performance.now();
    let frame = 0;
    const tick = () => {
      const progress = Math.min(1, (performance.now() - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}
