export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (message: string) => new HttpError(404, "not_found", message);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
