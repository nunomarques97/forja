export class HttpError extends Error {
  constructor(status, message = defaultMessage(status), headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

function defaultMessage(status) {
  return { 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error' }[status] ?? 'Error';
}
