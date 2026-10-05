# Output style

Everything jobtime prints for people follows these rules.

## Numbers

- Sizes use `formatBytes` (`src/format.mjs`): one decimal, binary units,
  `1.5 MB`, `900 B`.
- Counts are plain integers, no thousands separator.

## Durations

- Largest unit first, from `h`, `m`, `s`, separated by one space: `1h 2m 3s`.
- Units that are zero are left out: `2m`, `45s`, `1h 5s`.
- Hours never roll over into days: `26h 3m 4s`.
- Round down to whole seconds; anything under one second is written `<1s`.
- Never show raw milliseconds to people.

## Status words

- `ok` and `failed`, lower case.
