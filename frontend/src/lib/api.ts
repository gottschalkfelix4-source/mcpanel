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

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    tokenStore.clear();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
    throw new ApiError(401, 'Sitzung abgelaufen');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Fehler ${res.status}`, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Für Downloads: hängt das Token als Query-Parameter an. */
export function authedUrl(path: string): string {
  const token = tokenStore.get();
  const sep = path.includes('?') ? '&' : '?';
  return `/api${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`;
}

export async function uploadFiles(
  path: string,
  files: FileList | File[],
  onProgress?: (percent: number) => void,
): Promise<void> {
  const form = new FormData();
  for (const file of Array.from(files)) form.append('files', file, file.name);

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    const token = tokenStore.get();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
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
    xhr.onerror = () => reject(new ApiError(0, 'Netzwerkfehler beim Upload'));
    xhr.send(form);
  });
}
