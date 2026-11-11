import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownReply } from './components/MarkdownReply.tsx';
import { normalizeMathDelimiters, safeReplyUrl } from './markdown.ts';

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownReply, { content, locale: 'en' }));

test('rich replies render emphasis, lists, quotes, GFM tables, tasks and code as semantic elements', () => {
  const html = render('# Shanghai\n\n**Bold** and *italic* and ~~old~~.\n\n- First\n- Second\n\n1. One\n2. Two\n\n> Local advice\n\n| Place | Cost |\n| --- | --- |\n| Bund | Free |\n\n- [x] Planned\n\n`inline`\n\n```js\nconst cost = 10;\n```');
  for (const pattern of [/<h1>Shanghai/, /<strong>Bold/, /<em>italic/, /<del>old/, /<ul>/, /<ol>/, /<blockquote>/, /<table>/, /<th>Place/, /type="checkbox"/, /<code>inline/, /<pre><code class="language-js"/]) assert.match(html, pattern);
});

test('dollar and LaTeX delimiters render inline/display math with accessible MathML', () => {
  const html = render(String.raw`Inline $E=mc^2$ and \(a^2+b^2=c^2\).

$$
\frac{1}{2}+\sqrt{x}
$$

\[\sum_{i=1}^{n}i=\frac{n(n+1)}{2}\]`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 4);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
  assert.match(html, /<math xmlns=/);
  assert.match(html, /encoding="application\/x-tex"/);
});

test('math normalization preserves fenced, indented, inline code and escaped currency', () => {
  for (const text of [String.raw`\$20 and \$30`, '`\\(literal\\)`', '```tex\n\\[literal\\]\n```', '~~~tex\n\\(literal\\)\n~~~', '    \\(code\\)', '``\\(literal ` tick\\)``', String.raw`\\(escaped)`]) assert.equal(normalizeMathDelimiters(text), text);
  assert.equal(normalizeMathDelimiters(String.raw`\(x+y\)`), '$x+y$');
  assert.doesNotMatch(render(String.raw`Budget: \$20 and \$30.`), /class="katex"/);
});

test('incomplete streaming Markdown and invalid math remain renderable until completed', () => {
  const reply = '**Bold**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$$\n\\frac{1}{2}\n$$\n\n```js\nconst x = "<script>";\n```';
  for (let length = 1; length < reply.length; length += 3) assert.doesNotThrow(() => render(reply.slice(0, length)));
  const invalid = render('$$\n\\notARealMathCommand{x}\n$$');
  assert.match(invalid, /notARealMathCommand/);
  assert.match(render(reply), /class="katex"/);
});

test('raw HTML, unsafe links, remote images and trusted TeX commands cannot become active content', () => {
  const html = render('<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n[bad](javascript:alert) [data](data:text/html,test) [local](/api/health) ![alt](https://tracker.example/pixel)\n\n$\\href{javascript:alert(1)}{click}$');
  assert.doesNotMatch(html, /<script|<img|<iframe|onerror=|href="javascript:|href="data:|href="\/api/);
  assert.match(render('[Official site](https://example.com/info)'), /target="_blank" rel="noopener noreferrer"/);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//example.com', '/api/health', 'https://user:secret@example.com']) assert.equal(safeReplyUrl(url), undefined);
});
