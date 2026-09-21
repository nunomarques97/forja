// Claude transcripts repeat message usage across content blocks. Count each
// message once and apply only increases from later partial/final records.
export const USAGE_FIELDS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
];
export function usageAccumulator() {
  const seen = new Map();
  return (message) => {
    const id = typeof message.id === 'string' ? message.id : null;
    const previous = id ? seen.get(id) : null;
    const next = {},
      delta = {};
    for (const key of USAGE_FIELDS) {
      const raw = message.usage?.[key];
      const n =
        typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
          ? Math.trunc(raw)
          : 0;
      next[key] = Math.max(previous?.[key] || 0, n);
      delta[key] = next[key] - (previous?.[key] || 0);
    }
    if (id) seen.set(id, next);
    return { delta, newMessage: !previous };
  };
}
