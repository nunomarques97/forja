import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderMarkdown } from '../src/markdown.mjs';

test('headings, paragraphs and lists', () => {
  assert.equal(renderMarkdown('# Title\n\nOne\ntwo\n\n- a\n- b'), '<h1>Title</h1>\n<p>One two</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
});

test('links to pages become .html; other links are kept', () => {
  assert.equal(renderMarkdown('[Go](guide/install.md#top) [Web](https://example.com/x.md)'), '<p><a href="guide/install.html#top">Go</a> <a href="https://example.com/x.md">Web</a></p>');
});

test('code is escaped', () => {
  assert.equal(renderMarkdown('```\n<b> & </b>\n```'), '<pre><code>&lt;b&gt; &amp; &lt;/b&gt;</code></pre>');
  assert.equal(escapeHtml(`"it's"`), '&quot;it&#39;s&quot;');
});
