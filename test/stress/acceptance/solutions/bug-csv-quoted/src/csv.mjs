// CSV reader for bank exports: comma separated, fields may be quoted ("a, b"),
// a quote inside a quoted field is doubled, LF or CRLF line endings.
// Unquoted cells are trimmed; blank lines are skipped.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = () => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  const input = String(text);
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; wasQuoted = true; cell = ''; }
    else if (ch === ',') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r' && input[i + 1] === '\n') continue;
    else if (!wasQuoted) cell += ch;
  }
  if (cell !== '' || wasQuoted || row.length) endRow();
  return rows;
}
