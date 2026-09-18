// Minimal, dependency-free DOM stand-in for testing `applyQueuePatch`
// (viewer/assets/viewer.js) without a browser and without adding a DOM
// package (Node has none built in; the project stays at zero dependencies,
// CLAUDE.md). Parses the small, well-formed HTML subset the viewer emits
// (no void elements, no comments) and supports only what that function
// touches: element creation, `innerHTML` (get/set), `classList`, attributes,
// `textContent`, `value`/`disabled` on form controls, `querySelector(All)`
// with the selectors actually used (tag, `.class`, `[attr]`, `[attr="v"]`),
// `appendChild`/`remove`, and a `document.activeElement`/`focus()` pair good
// enough to assert that a node was never touched while "focused".
//
// This is test-only code, never imported by the app.
//
// Two honest limits, so nothing here is read as more proof than it is:
//
// 1. `appendChild`/`insertBefore` do NOT emulate the browser's focus loss.
//    In a real Chrome, moving a focused node (even "back to the same place")
//    detaches it and blurs it; here `document.activeElement` survives any
//    re-insertion. So a green focus test only proves the code does not
//    *recreate* the node — that the focus really survives is proved by the
//    Chrome screenshots in `docs/dogfood/`, never by this file.
// 2. `innerHTML` is a store, not a serializer: the getter returns the last
//    string assigned to it, so a block built by parsing (or changed through
//    `textContent`/properties) reads back as `''`. Assert on `textContent`
//    (or on attributes/properties) unless the test itself set that `innerHTML`.

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = s => String(s).replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, m => ENT[m]);

class FakeText {
  constructor(doc, text) { this.ownerDocument = doc; this.nodeType = 3; this.parentNode = null; this.data = text; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.nodeType = 1;
    this._tag = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this._value = '';
  }
  get classList() {
    const self = this;
    const set = () => new Set((self.attrs.get('class') || '').split(/\s+/).filter(Boolean));
    const put = s => self.attrs.set('class', [...s].join(' '));
    return {
      add: (...cs) => { const s = set(); cs.forEach(c => s.add(c)); put(s); },
      remove: (...cs) => { const s = set(); cs.forEach(c => s.delete(c)); put(s); },
      contains: c => set().has(c),
      toggle: (c, force) => { const s = set(); const has = s.has(c); const on = force === undefined ? !has : force; if (on) s.add(c); else s.delete(c); put(s); return on; },
    };
  }
  get dataset() {
    const self = this;
    return new Proxy({}, {
      get: (_, k) => self.attrs.get('data-' + String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase())),
      set: (_, k, v) => { self.attrs.set('data-' + String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase()), String(v)); return true; },
    });
  }
  get className() { return this.attrs.get('class') || ''; }
  set className(v) { this.attrs.set('class', v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  hasAttribute(k) { return this.attrs.has(k); }
  get disabled() { return this.attrs.has('disabled'); }
  set disabled(v) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  setSelectionRange() {}
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this; this.childNodes.push(node);
    if (node.nodeType === 1) this.children.push(node);
    return node;
  }
  removeChild(node) { this.childNodes = this.childNodes.filter(n => n !== node); this.children = this.children.filter(n => n !== node); node.parentNode = null; return node; }
  insertBefore(node, ref) {
    if (ref == null) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const ci = this.childNodes.indexOf(ref); this.childNodes.splice(ci < 0 ? this.childNodes.length : ci, 0, node);
    if (node.nodeType === 1) { const ei = this.children.indexOf(ref); this.children.splice(ei < 0 ? this.children.length : ei, 0, node); }
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; this.children = []; if (v !== '' && v != null) this.appendChild(new FakeText(this.ownerDocument, String(v))); }
  get innerHTML() { return this._raw || ''; }
  set innerHTML(html) { this._raw = String(html); this.childNodes = []; this.children = []; parseInto(this, this._raw, this.ownerDocument); }
  querySelectorAll(sel) { const out = []; walk(this, el => { if (matches(el, sel)) out.push(el); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function walk(root, fn) { for (const c of root.children) { fn(c); walk(c, fn); } }

function matches(el, sel) {
  return sel.split(',').map(s => s.trim()).some(single => {
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[-\w]+|\[[^\]]+\])*)$/.exec(single);
    if (!m) return false;
    const [, tag, rest] = m;
    if (tag && el._tag !== tag.toLowerCase()) return false;
    const parts = rest ? rest.match(/\.[-\w]+|\[[^\]]+\]/g) || [] : [];
    return parts.every(p => {
      if (p[0] === '.') return el.classList.contains(p.slice(1));
      const inner = p.slice(1, -1);
      const eq = /^([-\w:]+)\s*=\s*"([^"]*)"$/.exec(inner) || /^([-\w:]+)\s*=\s*'([^']*)'$/.exec(inner);
      if (eq) return el.getAttribute(eq[1].toLowerCase()) === eq[2];
      return el.hasAttribute(inner.toLowerCase());
    });
  });
}

// Tokenizer: open tag / close tag / text run. Good enough for the div/span/
// article/form/label/textarea/button markup the viewer emits (no `<`/`>` in
// text — the app escapes those with `esc()` before this ever sees them).
function parseInto(root, html, doc) {
  const stack = [root];
  const re = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      if (m[4].length) stack[stack.length - 1].appendChild(new FakeText(doc, decode(m[4])));
      continue;
    }
    if (m[1]) { // fecho
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i]._tag === tag) { stack.length = i; break; }
      continue;
    }
    const tag = m[2].toLowerCase();
    const el = new FakeElement(doc, tag);
    const attrsStr = m[3] || '';
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g;
    let am;
    while ((am = attrRe.exec(attrsStr))) {
      const name = am[1].toLowerCase();
      const val = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : (am[2] || '');
      el.attrs.set(name, decode(val));
    }
    stack[stack.length - 1].appendChild(el);
    if (!m[0].endsWith('/>')) stack.push(el);
  }
}

export class FakeDocument {
  constructor() { this.body = new FakeElement(this, 'body'); this.activeElement = this.body; }
  createElement(tag) { return new FakeElement(this, tag); }
}
