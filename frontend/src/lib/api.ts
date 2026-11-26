const TOKEN_KEY = 'mcpanel.token';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export const NETWORK_ERROR_MESSAGE =
  'Das Panel ist nicht erreichbar – läuft der Server noch? Bitte in einem Moment erneut versuchen.';

/**
 * Die Anfrage kam gar nicht bis zu einer Antwort: Backend neu gestartet, Netz
 * weg, Proxy aus. Muss von einer Absage des Servers unterscheidbar bleiben -
 * sonst sieht ein Container-Update aus wie ein falsches Passwort. Der Status 0
 * steht wie beim Upload fuer "keine Antwort erhalten".
 */
export class NetworkError extends ApiError {
  constructor(message: string = NETWORK_ERROR_MESSAGE) {
    super(0, message);
  }
}

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Ein Administrator hat den zweiten Faktor vorgeschrieben, während dieses
 * Konto angemeldet war. Das Backend lehnt dann fast alles mit 403 ab; der
 * AuthProvider lädt daraufhin das Konto neu und zeigt die Einrichtung.
 */
export const TOTP_REQUIRED_EVENT = 'mcpanel:totp-required';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new NetworkError();
  }

  if (res.status === 401) {
    // Die Meldung des Servers stehenlassen: bei einer fehlgeschlagenen
    // Anmeldung ist "Benutzername oder Passwort falsch" die Auskunft, die
    // weiterhilft - "Sitzung abgelaufen" schickt einen auf die falsche Faehrte.
    const data = (await res.json().catch(() => null)) as { error?: string } | null;

    // Nur eine bestehende Sitzung verwerfen. Ohne mitgesendetes Token gab es
    // keine, die ablaufen konnte - dann ist es ein Anmeldeversuch.
    // … und nur, wenn es noch dieselbe ist: eine verspätete Antwort auf das
    // alte Token (Passwortwechsel, „überall abmelden“) darf das neue nicht löschen.
    if (token && tokenStore.get() === token) {
      tokenStore.clear();
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw new ApiError(401, data?.error || 'Nicht angemeldet');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 403 && /Zwei-Faktor-Anmeldung vorgeschrieben/.test(data?.error ?? '')) {
      window.dispatchEvent(new Event(TOTP_REQUIRED_EVENT));
    }
    throw new ApiError(res.status, data?.error ?? `Fehler ${res.status}`, data?.details);
  }
  return data as T;
}

/**
 * KI-Assistent mit Live-Stream: `POST` auf einen SSE-Endpunkt, `onDelta`
 * bekommt jeden Textteil sofort, `onDone` die Abschluss-Metadaten (Modell,
 * Reparaturvorschläge). Ein Fehler – egal ob HTTP-Status oder `error`-Event
 * im Stream – wird als ApiError geworfen.
 */
export async function streamAssistant(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
  onDone: (meta: { model: string; actions?: unknown[] }) => void,
): Promise<void> {
  const token = tokenStore.get();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new NetworkError();
  }

  if (res.status === 401) {
    if (token && tokenStore.get() === token) {
      tokenStore.clear();
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    throw new ApiError(401, 'Nicht angemeldet');
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream')) {
    const text = await res.text().catch(() => '');
    let data: { error?: string } | null = null;
    try { data = JSON.parse(text) as { error?: string } | null; } catch { /* kein JSON */ }
    throw new ApiError(res.status, data?.error ?? (res.ok ? 'Unerwartete Antwort des Assistenten' : `Fehler ${res.status}`));
  }

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(res.status, 'Kein Antwort-Stream erhalten');

  let buffer = '';
  let angefangen = false;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const zeilen = buffer.split('\n');
      buffer = zeilen.pop() ?? '';
      let event = 'message';
      for (const zeile of zeilen) {
        if (zeile.startsWith('event:')) {
          event = zeile.slice(6).trim();
        } else if (zeile.startsWith('data:')) {
          const payload = zeile.slice(5).trim();
          if (!payload) continue;
          let data: { text?: string; message?: string; model?: string; actions?: unknown[] };
          try { data = JSON.parse(payload) as typeof data; } catch { continue; }
          if (event === 'delta' && typeof data.text === 'string') {
            angefangen = true;
            onDelta(data.text);
          } else if (event === 'error') {
            throw new ApiError(500, data.message ?? 'Der KI-Dienst hat einen Fehler gemeldet.');
          } else if (event === 'done') {
            onDone({ model: data.model ?? '', actions: data.actions ?? [] });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Manche Proxys schneiden den Stream nach [DONE] ab, ohne done-Event.
  if (!angefangen) throw new ApiError(500, 'Der KI-Dienst hat eine leere Antwort geschickt.');
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/**
 * Startet einen Download, den der Browser selbst lädt. Die Sitzung selbst
 * landet dabei nie in einer Adresse (Verlauf, Proxy-Protokolle): das Backend
 * stellt einen kurzlebigen Schlüssel aus, der nur für genau diesen Pfad gilt.
 */
export async function downloadFile(path: string): Promise<void> {
  const full = `/api${path}`;
  const { token } = await api.post<{ token: string }>('/auth/download-token', { path: full });
  const link = document.createElement('a');
  link.href = `${full}${full.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function uploadFiles<T = void>(
  path: string,
  files: FileList | File[],
  onProgress?: (percent: number) => void,
): Promise<T> {
  const form = new FormData();
  for (const file of Array.from(files)) form.append('files', file, file.name);

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    const token = tokenStore.get();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(xhr.responseText ? JSON.parse(xhr.responseText) : undefined); }
        catch { reject(new ApiError(xhr.status, 'Ungültige Antwort beim Upload')); }
      }
      else {
        let message = `Upload fehlgeschlagen (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText).error ?? message;
        } catch {
          /* Rohtext behalten */
        }
        reject(new ApiError(xhr.status, message));
      }
    };
    xhr.onerror = () => reject(new NetworkError('Netzwerkfehler beim Upload'));
    xhr.send(form);
  });
}
