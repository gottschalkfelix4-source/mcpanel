import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';
import type { Area, ChunkMapData, PlayerPosition, RegionBits } from './types';

export interface ChunkCanvasHandle {
  /** Ansicht auf einen Blockpunkt zentrieren */
  focus(x: number, z: number): void;
}

interface Props {
  data: ChunkMapData | undefined;
  players: PlayerPosition[];
  dimensionId: string;
  area: Area | null;
  /** Aktuell generierter Chunk (Chunk-Koordinaten) */
  current: { x: number; z: number } | null;
  /** Gesetzt = Klick auf die Karte wählt einen Punkt (Mittelpunkt der Vorgenerierung) */
  onPick?: (x: number, z: number) => void;
  height?: number;
}

const GENERATED = [91, 135, 49];
const BACKGROUND = '#0b0b0e';
const MIN_SCALE = 1 / 64;
const MAX_SCALE = 8;

/** 32×32-Bild einer Region, einmal je Inhalt erzeugt. */
const tileCache = new Map<string, HTMLCanvasElement>();

function regionTile(region: RegionBits): HTMLCanvasElement {
  const key = `${region.x},${region.z},${region.bits}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(32, 32);
  const bits = Uint8Array.from(atob(region.bits), (c) => c.charCodeAt(0));
  for (let i = 0; i < 1024; i++) {
    if (!(bits[i >> 3] & (1 << (i & 7)))) continue;
    const shade = ((i & 31) + (i >> 5)) & 1 ? 0.92 : 1;
    const o = i * 4;
    image.data[o] = GENERATED[0] * shade;
    image.data[o + 1] = GENERATED[1] * shade;
    image.data[o + 2] = GENERATED[2] * shade;
    image.data[o + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  tileCache.set(key, canvas);
  if (tileCache.size > 30_000) tileCache.delete(tileCache.keys().next().value!);
  return canvas;
}

/**
 * Übersichtskarte aus den Regionsdateien: generierte Chunks, geplanter bzw.
 * laufender Bereich, aktueller Chunk und Spieler. Ziehen verschiebt, das
 * Mausrad zoomt um den Zeiger.
 */
export const ChunkCanvas = forwardRef<ChunkCanvasHandle, Props>(function ChunkCanvas(
  { data, players, dimensionId, area, current, onPick, height = 620 },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: height });
  const [view, setView] = useState({ x: 0, z: 0, scale: 0.08 });
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  const fitted = useRef<string | null>(null);
  const pendingFocus = useRef<{ x: number; z: number } | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; z: number; moved: boolean } | null>(null);

  useImperativeHandle(ref, () => ({
    focus: (x, z) => {
      // Merken: kommen die Chunk-Daten erst danach, würde das Einpassen die
      // Ansicht sonst wieder auf die ganze Welt zurücksetzen.
      pendingFocus.current = { x, z };
      setView((v) => ({ ...v, x, z, scale: Math.max(v.scale, 0.5) }));
    },
  }), []);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    // Auf dem Handy nicht höher als 70 % des Bildschirms – sonst füllt die Karte
    // ihn ganz aus und die Seite lässt sich daran vorbei kaum noch scrollen.
    const observer = new ResizeObserver(([entry]) => setSize({
      w: Math.max(200, entry.contentRect.width),
      h: Math.max(280, Math.min(height, Math.round(window.innerHeight * 0.7))),
    }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [height]);

  // Beim ersten Laden bzw. Dimensionswechsel auf Bereich oder Welt einpassen.
  useEffect(() => {
    if (!data || fitted.current === data.dimension) return;
    fitted.current = data.dimension;
    if (pendingFocus.current) {
      const target = pendingFocus.current;
      pendingFocus.current = null;
      setView((v) => ({ x: target.x, z: target.z, scale: Math.max(v.scale, 0.5) }));
      return;
    }
    if (area) {
      setView({ x: area.centerX, z: area.centerZ, scale: clamp(Math.min(size.w, size.h) / (area.radius * 2.6)) });
      return;
    }
    if (data.regions.length === 0) {
      setView({ x: 0, z: 0, scale: 0.25 });
      return;
    }
    const xs = data.regions.map((r) => r.x), zs = data.regions.map((r) => r.z);
    const minX = Math.min(...xs) * 512, maxX = (Math.max(...xs) + 1) * 512;
    const minZ = Math.min(...zs) * 512, maxZ = (Math.max(...zs) + 1) * 512;
    setView({
      x: (minX + maxX) / 2, z: (minZ + maxZ) / 2,
      scale: clamp(Math.min(size.w / (maxX - minX), size.h / (maxZ - minZ)) * 0.9),
    });
  }, [data, area, size.w, size.h]);

  const visiblePlayers = useMemo(() => players.filter((p) => !p.dimension || p.dimension === dimensionId), [players, dimensionId]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    // Nur bei geänderter Größe neu anlegen – sonst entstünde bei jedem Bild
    // beim Ziehen ein neuer Zeichenpuffer.
    const pixelW = Math.round(size.w * dpr), pixelH = Math.round(size.h * dpr);
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, size.w, size.h);

    const sx = (x: number) => (x - view.x) * view.scale + size.w / 2;
    const sz = (z: number) => (z - view.z) * view.scale + size.h / 2;

    // Bereich: Fläche zuerst, damit ungenerierte Chunks darin sichtbar sind.
    if (area) {
      ctx.fillStyle = 'rgba(44, 44, 51, 0.9)';
      areaPath(ctx, area, sx, sz, view.scale);
      ctx.fill();
    }

    if (data) {
      const regionPx = 512 * view.scale;
      for (const region of data.regions) {
        const left = sx(region.x * 512), top = sz(region.z * 512);
        if (left > size.w || top > size.h || left + regionPx < 0 || top + regionPx < 0) continue;
        ctx.drawImage(regionTile(region), left, top, regionPx, regionPx);
      }
      // Regionsgrenzen bei starkem Zoom
      if (view.scale >= 0.5) {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = 1;
        for (const region of data.regions) {
          ctx.strokeRect(sx(region.x * 512) + 0.5, sz(region.z * 512) + 0.5, regionPx, regionPx);
        }
      }
    }

    // Zurücksetzen: was wegfällt, rot überlagern – außerhalb oder innerhalb.
    if (area?.trim) {
      ctx.save();
      ctx.fillStyle = 'rgba(232, 69, 60, 0.32)';
      if (area.trim === 'outside') {
        ctx.beginPath();
        ctx.rect(0, 0, size.w, size.h);
        areaPath(ctx, area, sx, sz, view.scale, false);
        ctx.fill('evenodd');
      } else {
        areaPath(ctx, area, sx, sz, view.scale);
        ctx.fill();
      }
      ctx.restore();
    }

    if (area) {
      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = area.trim ? '#E8453C' : '#FFAA00';
      areaPath(ctx, area, sx, sz, view.scale);
      ctx.stroke();
      ctx.restore();
    }

    if (current) {
      const x = sx(current.x * 16 + 8), z = sz(current.z * 16 + 8);
      ctx.fillStyle = '#FFAA00';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(255, 170, 0, 0.8)';
      ctx.shadowBlur = 14;
      ctx.fillRect(x - 6, z - 6, 12, 12);
      ctx.shadowBlur = 0;
      ctx.strokeRect(x - 6, z - 6, 12, 12);
    }

    // Weltmitte
    ctx.save();
    ctx.translate(sx(0), sz(0));
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#E8453C';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fillRect(-6, -6, 12, 12);
    ctx.strokeRect(-6, -6, 12, 12);
    ctx.restore();

    ctx.font = '600 12px Rubik, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const player of visiblePlayers) {
      const x = sx(player.x), z = sz(player.z);
      ctx.fillStyle = '#4AEDD9';
      ctx.strokeStyle = '#0d0d0f';
      ctx.lineWidth = 2;
      ctx.fillRect(x - 7, z - 7, 14, 14);
      ctx.strokeRect(x - 7, z - 7, 14, 14);
      const width = ctx.measureText(player.name).width + 10;
      ctx.fillStyle = 'rgba(13, 13, 15, 0.85)';
      ctx.fillRect(x + 11, z - 10, width, 20);
      ctx.fillStyle = '#f2f2f4';
      ctx.fillText(player.name, x + 16, z);
    }
  }, [area, current, data, size, view, visiblePlayers]);

  useEffect(draw, [draw]);

  const toWorld = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.round((event.clientX - rect.left - size.w / 2) / view.scale + view.x),
      z: Math.round((event.clientY - rect.top - size.h / 2) / view.scale + view.z),
    };
  };

  const zoom = (factor: number, anchor?: { clientX: number; clientY: number }) => {
    setView((v) => {
      const scale = clamp(v.scale * factor);
      if (!anchor) return { ...v, scale };
      const rect = canvasRef.current!.getBoundingClientRect();
      const ax = anchor.clientX - rect.left - size.w / 2, az = anchor.clientY - rect.top - size.h / 2;
      const wx = ax / v.scale + v.x, wz = az / v.scale + v.z;
      return { scale, x: wx - ax / scale, z: wz - az / scale };
    });
  };

  // Mausrad nicht passiv – sonst scrollt die Seite mit.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.25 : 0.8, event);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  });

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden" style={{ height: size.h }}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: onPick ? 'crosshair' : drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        aria-label="Karte der generierten Chunks"
        role="img"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { px: e.clientX, py: e.clientY, x: view.x, z: view.z, moved: false };
        }}
        onPointerMove={(e) => {
          setHover(toWorld(e));
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.px, dz = e.clientY - d.py;
          if (Math.abs(dx) + Math.abs(dz) > 4) d.moved = true;
          if (d.moved) setView((v) => ({ ...v, x: d.x - dx / v.scale, z: d.z - dz / v.scale }));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved && onPick) {
            const point = toWorld(e);
            onPick(point.x, point.z);
          }
        }}
        onPointerLeave={() => setHover(null)}
      />

      <div className="pointer-events-none absolute left-3 top-3 border border-stone-700 bg-stone-950/85 px-2.5 py-1.5 font-mono text-xs text-stone-200">
        {hover ? `X ${hover.x} · Z ${hover.z}` : `${data?.chunks.toLocaleString('de-DE') ?? '…'} Chunks generiert`}
        {onPick && <span className="ml-2 text-gold">Klicken wählt den Mittelpunkt</span>}
      </div>

      <div className="absolute right-3 top-3 flex flex-col border border-stone-950">
        <button type="button" aria-label="Hineinzoomen" className="grid h-9 w-9 place-items-center border-b border-stone-950 bg-stone-700 text-stone-50 hover:bg-stone-600" onClick={() => zoom(1.5)}><Plus size={16} /></button>
        <button type="button" aria-label="Herauszoomen" className="grid h-9 w-9 place-items-center border-b border-stone-950 bg-stone-700 text-stone-50 hover:bg-stone-600" onClick={() => zoom(1 / 1.5)}><Minus size={16} /></button>
        <button type="button" aria-label="Auf Weltmitte zentrieren" className="grid h-9 w-9 place-items-center bg-stone-700 text-stone-50 hover:bg-stone-600" onClick={() => setView((v) => ({ ...v, x: area?.centerX ?? 0, z: area?.centerZ ?? 0 }))}><Crosshair size={15} /></button>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-3 border border-stone-700 bg-stone-950/85 px-2.5 py-1.5 text-xs text-stone-200">
        <Legend color="#5B8731" label="generiert" />
        {area && !area.trim && <Legend color="#2c2c33" label="noch leer" />}
        {area && <Legend dashed={area.trim ? '#E8453C' : '#FFAA00'} label="Bereich" />}
        {area?.trim && <Legend color="rgba(232, 69, 60, 0.6)" label="wird zurückgesetzt" />}
        <Legend color="#4AEDD9" label="Spieler" />
        <Legend color="#E8453C" label="Weltmitte" />
      </div>
      {data?.truncated && (
        <p className="absolute bottom-3 right-3 border border-gold/40 bg-stone-950/85 px-2 py-1 text-xs text-gold">Sehr große Welt – nur ein Teil wird gezeigt</p>
      )}
    </div>
  );
});

function Legend({ color, label, dashed }: { color?: string; label: string; dashed?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="block h-3 w-3" style={dashed ? { border: `2px dashed ${dashed}` } : { background: color, border: '1px solid #0d0d0f' }} />
      {label}
    </span>
  );
}

function clamp(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function areaPath(
  ctx: CanvasRenderingContext2D, area: Area, sx: (x: number) => number, sz: (z: number) => number, scale: number, begin = true,
) {
  if (begin) ctx.beginPath();
  else ctx.moveTo(sx(area.centerX + (area.shape === 'circle' ? area.radius : -area.radius)), sz(area.centerZ - (area.shape === 'circle' ? 0 : area.radius)));
  if (area.shape === 'circle') ctx.arc(sx(area.centerX), sz(area.centerZ), area.radius * scale, 0, Math.PI * 2);
  else ctx.rect(sx(area.centerX - area.radius), sz(area.centerZ - area.radius), area.radius * 2 * scale, area.radius * 2 * scale);
}
