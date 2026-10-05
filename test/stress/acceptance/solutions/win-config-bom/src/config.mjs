import { existsSync, readFileSync } from 'node:fs';

export const DEFAULTS = Object.freeze({
  server: { host: '127.0.0.1', port: 3000 },
  log: { level: 'info', pretty: false },
  features: [],
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {}))
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  return out;
}

// Text of a file as Windows tools write it: UTF-16 LE with a BOM, or UTF-8
// with or without a BOM.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  return bytes.toString('utf8');
}

export function readConfigFile(file) {
  if (!file || !existsSync(file)) return {};
  try {
    return JSON.parse(decodeText(readFileSync(file)));
  } catch (error) {
    throw new Error(`Invalid config file ${file}: ${error.message}`);
  }
}

export function loadConfig({ defaults = DEFAULTS, file } = {}) {
  return deepMerge(defaults, readConfigFile(file));
}
