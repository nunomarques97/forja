export class HttpError extends Error {
  constructor(status, message = defaultMessage(status)) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function defaultMessage(status) {
  return { 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error' }[status] ?? 'Error';
}
