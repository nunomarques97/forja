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

export function readConfigFile(file) {
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function loadConfig({ defaults = DEFAULTS, file } = {}) {
  return deepMerge(defaults, readConfigFile(file));
}
