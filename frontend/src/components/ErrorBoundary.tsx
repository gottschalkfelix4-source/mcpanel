import React from 'react';
import { AlertTriangle } from 'lucide-react';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * Fängt Render-Fehler ab, die sonst den kompletten Baum abräumen und eine
 * schwarze Seite hinterlassen. Häufigster Auslöser ist ein kurz nicht
 * erreichbares Backend: Abfragen geben dann undefined zurück, während einzelne
 * Seiten die Daten als vorhanden annehmen.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Unerwarteter Fehler in der Oberfläche:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="mc-frame w-full max-w-lg">
          <div className="mc-frame-inner space-y-4 p-6">
            <div className="flex items-center gap-3">
              <AlertTriangle className="shrink-0 text-redstone" size={22} />
              <h1 className="font-pixel text-sm text-stone-100">Etwas ist schiefgelaufen</h1>
            </div>

            <p className="text-sm leading-relaxed text-stone-300">
              Die Oberfläche konnte nicht dargestellt werden. Wenn das Panel gerade neu
              gestartet wurde, hilft meist ein Neuladen der Seite.
            </p>

            <pre className="mc-well max-h-40 overflow-auto p-3 font-mono text-xs text-stone-300">
              {error.message}
            </pre>

            <div className="flex gap-2">
              <button
                onClick={() => window.location.reload()}
                className="mc-btn mc-btn-primary flex-1"
              >
                Seite neu laden
              </button>
              <button
                onClick={() => this.setState({ error: null })}
                className="mc-btn mc-btn-ghost flex-1"
              >
                Noch einmal versuchen
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
