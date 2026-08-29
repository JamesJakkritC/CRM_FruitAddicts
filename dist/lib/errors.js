/** Domain/HTTP error with a machine-readable code and HTTP status. */
export class AppError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export const badRequest = (msg, details) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Unauthorized') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);
export const conflict = (msg, details) => new AppError(409, 'conflict', msg, details);
export const unprocessable = (msg, details) => new AppError(422, 'unprocessable', msg, details);
//# sourceMappingURL=errors.js.map