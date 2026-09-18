// Greeting helpers. Portuguese, always ending with an exclamation mark (see CLAUDE.md).
export function greet(name) {
  const who = String(name ?? '').trim();
  return who ? `Olá, ${who}!` : 'Olá!';
}

export function greetAll(names) {
  return (names || []).map(greet);
}
