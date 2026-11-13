import { useEffect } from 'react';

/**
 * Warnt beim Schließen oder Neuladen der Seite, solange Eingaben nicht
 * gespeichert sind. (Den Reiterwechsel innerhalb des Panels deckt das nicht ab.)
 */
export function useUnsavedWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
