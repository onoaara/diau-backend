export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const unauthorized = (message = "Sign in to continue.") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You don't have permission to do that.") => new HttpError(403, "forbidden", message);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found.`);
export const conflict = (message: string, fields?: Record<string, string[]>) =>
  new HttpError(409, "conflict", message, fields);
