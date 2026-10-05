// The Markdown subset our docs use: headings, paragraphs, "-" lists, fenced
// code blocks, `code` spans and [links](page.md). Links to .md pages become
// links to the generated .html pages.
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const pageLink = href => (/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : href.replace(/\.md(#.*)?$/, '.html$1'));

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => `<a href="${pageLink(href)}">${label}</a>`);
}

export function renderMarkdown(text) {
  const out = [];
  let paragraph = [], list = null, fence = null;
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    if (list) out.push(`<ul>\n${list.map(item => `<li>${inline(item)}</li>`).join('\n')}\n</ul>`);
    paragraph = [];
    list = null;
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (fence) {
      if (line.startsWith('```')) {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (line.startsWith('```')) {
      flush();
      fence = [];
    } else if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (item) {
      if (paragraph.length) flush();
      (list ??= []).push(item[1]);
    } else if (!line.trim()) flush();
    else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  if (fence) out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  flush();
  return out.join('\n');
}
