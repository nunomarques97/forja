# jobtime

Prints the status of our nightly build jobs.

```
node src/cli.mjs jobs.json
```

`jobs.json` is a list of `{ "name", "ok", "durationMs", "artifactBytes" }`.
Output follows [docs/STYLE.md](docs/STYLE.md).
