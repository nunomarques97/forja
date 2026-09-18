// HTML/SVG text escaping. Used everywhere untrusted text (a name typed in a form) lands inside
// markup — see docs/forja/TECHNOLOGY.md S0.4 ("escapar sempre").
//
// Order matters: '&' must be replaced first, otherwise the '&' produced by the other
// replacements (e.g. '&lt;') would itself get escaped into '&amp;lt;'.
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
