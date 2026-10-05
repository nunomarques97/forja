// CLI arguments in any order: options --json and --failed, one jobs file.
export function parseArgs(argv) {
  const options = { json: false, failed: false, file: null };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--failed') options.failed = true;
    else if (arg.startsWith('--')) throw Error(`unknown option ${arg}`);
    else if (options.file) throw Error('only one jobs file');
    else options.file = arg;
  }
  if (!options.file) throw Error('missing jobs file');
  return options;
}
