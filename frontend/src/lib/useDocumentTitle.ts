import { useEffect } from 'react';

const BASIS = 'MCPanel';

/** Titel des Browser-Tabs – bei mehreren offenen Servern sonst alle gleich. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BASIS}` : `${BASIS} – Minecraft-Server`;
    return () => { document.title = `${BASIS} – Minecraft-Server`; };
  }, [title]);
}
