import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** QR-Code als SVG – ohne innerHTML und ohne Anfrage an einen fremden Dienst. */
export default function QrCode({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { size: count + 8, path: d };
  }, [value]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-48 w-48 border border-stone-950 bg-white"
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR-Code für die Authenticator-App"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

