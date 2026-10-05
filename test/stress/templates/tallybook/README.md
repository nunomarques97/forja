# tallybook

A small household ledger: import bank CSV exports, categorize entries and print
monthly reports.

```
node src/cli.mjs import statement.csv
node src/cli.mjs report
node src/cli.mjs balance
```

## Conventions

- Money is always an integer number of **cents** (`amountCents`). Only
  `src/money.mjs` converts between text and cents.
- Dates are ISO `YYYY-MM-DD` strings, interpreted in UTC (`src/dates.mjs`).
- Categories are compared after `normalizeCategory` (`src/categories.mjs`).
- Invalid input throws a `ParseError` (`src/errors.mjs`) with the line number
  when there is one.
- The ledger is stored as JSON in `tally.json` in the working directory
  (override with `TALLY_FILE`).
- `src/cli.mjs` exports `main(argv, { storePath, write })`; commands print
  through `write` so tests can capture the output.
