/** Accept both LaTeX-style and dollar delimiters without rewriting code examples. */
export function normalizeMathDelimiters(source: string): string {
  let output = '', index = 0;
  let fence: { marker: string; length: number } | undefined;
  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      const end = source.indexOf('\n', index);
      const lineEnd = end < 0 ? source.length : end + 1;
      const line = source.slice(index, lineEnd);
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence.marker && marker.length >= fence.length && line.slice(line.indexOf(marker) + marker.length).trim() === '') fence = undefined;
        output += line; index = lineEnd; continue;
      }
      if (marker) { fence = { marker: marker[0]!, length: marker.length }; output += line; index = lineEnd; continue; }
      if (/^( {4}|\t)/.test(line)) { output += line; index = lineEnd; continue; }
    }
    if (source[index] === '`') {
      let length = 1;
      while (source[index + length] === '`') length++;
      const delimiter = '`'.repeat(length);
      let close = source.indexOf(delimiter, index + length);
      while (close >= 0 && (source[close - 1] === '`' || source[close + length] === '`')) close = source.indexOf(delimiter, close + length);
      const end = close < 0 ? source.length : close + length;
      output += source.slice(index, end); index = end; continue;
    }
    if (source[index] === '\\') {
      const next = source[index + 1];
      if (next === '(' || next === '[') {
        const close = source.indexOf(next === '(' ? '\\)' : '\\]', index + 2);
        if (close >= 0) {
          const formula = source.slice(index + 2, close);
          output += next === '(' ? `$${formula}$` : `\n$$\n${formula}\n$$\n`;
          index = close + 2; continue;
        }
      }
      output += source.slice(index, index + 2); index += 2; continue;
    }
    output += source[index++];
  }
  return output;
}

/** Model-authored links are explicit navigation only, never scripts or local API paths. */
export function safeReplyUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Read visible prose once per click; avoid Markdown punctuation and duplicate math trees. */
export function readableReplyText(root: HTMLElement | null, fallback: string): string {
  if (!root) return fallback;
  const block = new Set(['P', 'DIV', 'PRE', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR']);
  function visit(node: Node): string {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as HTMLElement;
    if (element.classList.contains('katex')) return element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
    if (element.tagName === 'BR') return '\n';
    if (element.tagName === 'INPUT' || element.tagName === 'BUTTON') return '';
    const text = Array.from(element.childNodes, visit).join('');
    return block.has(element.tagName) ? `${text}\n` : ['TH', 'TD'].includes(element.tagName) ? `${text}\t` : text;
  }
  return visit(root).replace(/\n{3,}/g, '\n\n').trim() || fallback;
}
