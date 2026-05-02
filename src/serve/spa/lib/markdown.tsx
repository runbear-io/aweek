/**
 * Shared `<Markdown>` component built on react-markdown + remark-gfm.
 *
 * Replaces the hand-rolled block/inline parsers in `agent-plan-page.tsx`
 * and `agent-reviews-page.tsx`. Gains GFM task lists, tables,
 * strikethrough, and autolinks for free.
 *
 * All elements are styled with shadcn design tokens so they re-theme
 * correctly in both light and dark modes without hardcoded palette
 * utilities.
 *
 * @module serve/spa/lib/markdown
 */

import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

// ── Component map ─────────────────────────────────────────────────────

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1
      className="mt-6 mb-3 text-lg font-semibold leading-tight first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2
      className="mt-5 mb-2 text-base font-semibold leading-tight border-b pb-1 first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3
      className="mt-4 mb-2 text-sm font-semibold leading-tight first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4
      className="mt-3 mb-1.5 text-sm font-medium uppercase tracking-wider text-muted-foreground first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p className="my-2 first:mt-0 last:mb-0" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, className, ...props }) => {
    const isTaskList = className?.includes('contains-task-list');
    return (
      <ul
        className={
          isTaskList
            ? 'my-2 space-y-1'
            : 'my-2 ml-5 list-disc space-y-1 marker:text-muted-foreground'
        }
        {...props}
      >
        {children}
      </ul>
    );
  },
  ol: ({ children, ...props }) => (
    <ol
      className="my-2 ml-5 list-decimal space-y-1 marker:text-muted-foreground"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, className, ...props }) => {
    const isTaskItem = className?.includes('task-list-item');
    return (
      <li
        className={isTaskItem ? 'flex items-start gap-2 my-0.5' : undefined}
        {...props}
      >
        {children}
      </li>
    );
  },
  input: ({ type, disabled, ...props }) => {
    if (type === 'checkbox') {
      return (
        <input
          type="checkbox"
          disabled
          className="mt-1 h-3.5 w-3.5 rounded border-border bg-background accent-primary"
          {...props}
        />
      );
    }
    return <input type={type} disabled={disabled} {...props} />;
  },
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-3 border-l-4 border-border pl-3 text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),
  // Fenced code blocks: wrap the <pre> in an `overflow-x-auto` scroll
  // container so long lines scroll horizontally inside the block instead
  // of pushing the page wider than the viewport (critical at 375px).
  // `max-w-full` plus the wrapper guarantees the code box never exceeds
  // its parent's width even when a flex/grid ancestor lacks `min-w-0`.
  pre: ({ children, ...props }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-md border bg-muted/40">
      <pre
        className="p-3 font-mono text-xs leading-5"
        {...props}
      >
        {children}
      </pre>
    </div>
  ),
  code: ({ className, children, ...props }) => {
    // Fenced code blocks get a `language-*` class from remark; inline
    // code does not. Use the class as the discriminator.
    const isFenced = Boolean(className?.startsWith('language-'));
    if (isFenced) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  },
  a: ({ href, children, ...props }) => {
    const isExternal = typeof href === 'string' && href.startsWith('http');
    return (
      <a
        href={href}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        {...(isExternal
          ? { target: '_blank', rel: 'noopener noreferrer' }
          : {})}
        {...props}
      >
        {children}
      </a>
    );
  },
  strong: ({ children, ...props }) => (
    <strong className="font-semibold" {...props}>
      {children}
    </strong>
  ),
  del: ({ children, ...props }) => (
    <del className="line-through text-muted-foreground" {...props}>
      {children}
    </del>
  ),
  table: ({ children, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-muted/50" {...props}>
      {children}
    </thead>
  ),
  tr: ({ children, ...props }) => (
    <tr className="border-b last:border-b-0" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th
      className="px-3 py-1.5 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-3 py-1.5 align-top tabular-nums" {...props}>
      {children}
    </td>
  ),
  hr: ({ ...props }) => (
    <hr className="my-4 border-border" {...props} />
  ),
};

// ── Public component ──────────────────────────────────────────────────

export interface MarkdownProps {
  /** Raw markdown string to render. */
  source: string;
}

/**
 * `<Markdown source={string} />` — renders markdown with GFM extensions
 * (task lists, tables, strikethrough, autolinks) using shadcn design tokens.
 */
export function Markdown({ source }: MarkdownProps): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {source}
    </ReactMarkdown>
  );
}

export default Markdown;
