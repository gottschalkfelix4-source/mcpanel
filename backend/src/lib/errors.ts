export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = 'Nicht angemeldet') => new HttpError(401, m);
export const forbidden = (m = 'Keine Berechtigung') => new HttpError(403, m);
export const notFound = (m = 'Nicht gefunden') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
