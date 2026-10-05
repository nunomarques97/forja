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

// APP_SERVER__PORT=8080 -> { server: { port: 8080 } }. Values are parsed as
// JSON when they can be (numbers, booleans, arrays), otherwise kept as text.
export function envOverrides(env, prefix = 'APP_') {
  const out = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(prefix)) continue;
    const path = name.slice(prefix.length).toLowerCase().split('__');
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    let node = out;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path.at(-1)] = value;
  }
  return out;
}

// Precedence: environment over file over defaults, merged key by key.
export function loadConfig({ defaults = DEFAULTS, file, env = process.env } = {}) {
  return deepMerge(deepMerge(defaults, readConfigFile(file)), envOverrides(env));
}
