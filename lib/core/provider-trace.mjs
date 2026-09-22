import { openSync, writeSync, closeSync } from 'node:fs';

// Metadata only. Event receipt times include CLI buffering and are not model
// inference timings. Never reconstruct token/cost usage from this journal.
const eventTypes = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.updated', 'item.completed', 'error',
  'system', 'assistant', 'user', 'result', 'stream_event',
]);
const itemTypes = new Set([
  'command_execution', 'file_change', 'agent_message', 'reasoning',
  'mcp_tool_call', 'web_search', 'todo_list', 'error',
]);
const statuses = new Set(['in_progress', 'completed', 'failed', 'declined']);

export function providerTrace(path, provider, maxEvents = 10000) {
  const fd = openSync(path, 'wx'); // Refuse collisions and existing symlinks.
  let closed = false;
  const summary = {
    source: 'stdout JSON event receipt; not inference time or token usage',
    events: 0, recorded_events: 0, dropped_events: 0, unparsed_lines: 0,
    first_event_ms: null, last_event_ms: null,
  };
  const append = row => writeSync(fd, JSON.stringify(row) + '\n');
  try { append({ kind: 'start', version: 1, provider, at: new Date().toISOString() }); }
  catch (error) { closeSync(fd); throw error; }
  return {
    observe(line, elapsed_ms) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { summary.unparsed_lines++; return; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
        summary.unparsed_lines++; return;
      }
      summary.events++;
      summary.first_event_ms ??= elapsed_ms;
      summary.last_event_ms = elapsed_ms;
      if (summary.recorded_events >= maxEvents) { summary.dropped_events++; return; }
      const item = event.item;
      const row = { kind: 'event', sequence: summary.events, elapsed_ms, type: eventTypes.has(event.type) ? event.type : 'other' };
      if (item && typeof item === 'object') row.item = {
        id: typeof item.id === 'string' && /^[\w-]{1,80}$/.test(item.id) ? item.id : null,
        type: itemTypes.has(item.type) ? item.type : 'other',
        status: statuses.has(item.status) ? item.status : null,
        exit_code: Number.isSafeInteger(item.exit_code) ? item.exit_code : null,
      };
      append(row);
      summary.recorded_events++;
    },
    finish() {
      if (!closed) {
        try { append({ kind: 'end', ...summary }); }
        finally { closed = true; closeSync(fd); }
      }
      return { ...summary };
    },
  };
}
