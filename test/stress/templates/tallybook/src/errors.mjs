export class TallyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TallyError';
  }
}

export class ParseError extends TallyError {
  constructor(message, line = null) {
    super(line === null ? message : `line ${line}: ${message}`);
    this.name = 'ParseError';
    this.line = line;
  }
}
