import { memo } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeMathDelimiters, safeReplyUrl } from '../markdown.ts';
import { copy, type Locale } from '../copy.ts';

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];
const rehypePlugins: Options['rehypePlugins'] = [[rehypeKatex, { trust: false, maxExpand: 200, maxSize: 20, strict: 'ignore', errorColor: '#52617a' }]];

/** No raw HTML plugin, generated image requests, or trusted TeX commands. */
export function MarkdownReply({ content, locale }: { content: string; locale: Locale }) {
  return <div className="message-text markdown-reply">
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml urlTransform={safeReplyUrl} components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span>{alt}</span>,
      table: ({ children }) => <div className="markdown-table" role="region" aria-label={copy[locale].replyTable} tabIndex={0}><table>{children}</table></div>,
    }}>{normalizeMathDelimiters(content)}</ReactMarkdown>
  </div>;
}

export default memo(MarkdownReply);
