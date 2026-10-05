#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const USAGE = 'usage: docpack build <docs-folder> <output-folder>';

// Returns the exit code.
export function main(argv, { log = console.log, error = console.error } = {}) {
  const [command, src, out] = argv;
  if (command !== 'build' || !src || !out) {
    error(USAGE);
    return 2;
  }
  const pages = build({ src, out });
  log(`built ${pages.length} pages into ${out}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
