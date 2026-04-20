/**
 * Plan section — data gathering + HTML rendering for the `aweek serve`
 * dashboard's "Plan" card.
 *
 * Reads `.aweek/agents/<slug>/plan.md` live on every request (via
 * `readPlan` from the plan-markdown store — no duplicated persistence
 * logic) and renders it as formatted HTML. A small agent picker sits
 * above the rendered body so the operator can flip between agents
 * without leaving the page; the selected agent is carried over the
 * URL as `?agent=<slug>` so links are shareable.
 *
 * Why a hand-rolled markdown renderer? The CLAUDE.md constraints call
 * out "minimal-dependencies: Lightweight framework choice, no heavy
 * frontend build toolchain". A ~150-line subset of CommonMark covers
 * everything we need for plan.md (H1–H4, paragraphs, bullet/ordered
 * lists, code blocks + inline code, bold/italic, links, blockquotes,
 * and HTML-comment stripping) and keeps the zero-dependency posture
 * established by the rest of `src/serve/`.
 *
 * The renderer is intentionally conservative: every interpolation
 * point is HTML-escaped before any markdown transformation runs, so a
 * plan.md body that happens to contain `<script>` text is safe to
 * inject into the dashboard shell verbatim.
 */

import { join } from 'node:path';
import { listAllAgents } from '../storage/agent-helpers.js';
import { readPlan } from '../storage/plan-markdown-store.js';
import { readSubagentIdentity } from '../subagents/subagent-file.js';

/**
 * Gather the data the plan card needs for a given request.
 *
 * Returns the full list of hired agents (so the picker can render even
 * when the selected agent has no plan yet) plus the markdown body for
 * the resolved selection. When the caller-provided `selectedSlug` does
 * not match any agent, falls back to the alphabetically-first agent so
 * the card always has something sensible to show.
 *
 * Individual failures — a missing subagent .md, an unreadable plan.md
 * — never cascade: we absorb per-agent errors the same way the agents
 * section does and keep the dashboard responsive.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string} [opts.selectedSlug]
 * @returns {Promise<{
 *   agents: Array<{ slug: string, name: string }>,
 *   selected: { slug: string, name: string, markdown: string | null, hasPlan: boolean } | null,
 * }>}
 */
export async function gatherPlans({ projectDir, selectedSlug } = {}) {
  if (!projectDir) throw new Error('gatherPlans: projectDir is required');
  const agentsDir = join(projectDir, '.aweek', 'agents');

  const configs = await listAllAgents({ dataDir: agentsDir });
  if (configs.length === 0) {
    return { agents: [], selected: null };
  }

  // Resolve a friendly display name per agent. Falls back to the slug
  // when the `.claude/agents/<slug>.md` is missing — mirrors the
  // agents-section behaviour so the two cards stay in sync.
  const agents = await Promise.all(
    configs.map(async (config) => {
      const identity = await readSubagentIdentity(config.id, projectDir).catch(
        () => ({ missing: true, name: '' }),
      );
      const name = identity?.missing ? config.id : identity?.name || config.id;
      return { slug: config.id, name };
    }),
  );
  agents.sort((a, b) => a.name.localeCompare(b.name));

  // Pick the selection: honour `selectedSlug` when it matches, otherwise
  // fall back to the first agent. We never throw on an invalid slug
  // because the URL is user-supplied and we want the dashboard to
  // degrade to "show something useful" rather than 404.
  const selection =
    (selectedSlug && agents.find((a) => a.slug === selectedSlug)) || agents[0];

  const markdown = await readPlan(agentsDir, selection.slug).catch(() => null);

  return {
    agents,
    selected: {
      slug: selection.slug,
      name: selection.name,
      markdown,
      hasPlan: typeof markdown === 'string' && markdown.trim().length > 0,
    },
  };
}

/**
 * Render the plan card body. The top strip lists every hired agent as
 * a pill link; the selected pill is highlighted and the rest link to
 * `?agent=<slug>`. Below the picker we render the selected agent's
 * plan.md as HTML — or a friendly empty state when no plan has been
 * written yet.
 *
 * @param {{
 *   agents: Array<{ slug: string, name: string }>,
 *   selected: { slug: string, name: string, markdown: string | null, hasPlan: boolean } | null,
 * }} plans
 * @returns {string}
 */
export function renderPlanSection(plans) {
  const agents = plans?.agents || [];
  const selected = plans?.selected || null;

  if (agents.length === 0) {
    return `<div class="plan-empty">No agents yet. Run <code>/aweek:hire</code> to create one.</div>`;
  }

  const picker = renderAgentPicker(agents, selected);
  const body = renderPlanBody(selected);

  return `${picker}${body}`;
}

/**
 * Render the horizontally-scrolling agent picker. Kept as a pure
 * function so the plan card can be snapshot-tested without exercising
 * the HTTP layer.
 *
 * @param {Array<{ slug: string, name: string }>} agents
 * @param {{ slug: string } | null} selected
 * @returns {string}
 */
function renderAgentPicker(agents, selected) {
  const items = agents
    .map((agent) => {
      const isSelected = selected && selected.slug === agent.slug;
      const cls = isSelected ? 'plan-pill selected' : 'plan-pill';
      // Selected pill is rendered as a non-link span so screen readers
      // do not announce a no-op link and pointer users get a clear
      // "current" affordance.
      if (isSelected) {
        return `<span class="${cls}" aria-current="page" data-agent-slug="${escapeAttr(agent.slug)}">${escapeHtml(agent.name)}</span>`;
      }
      const href = `?agent=${encodeURIComponent(agent.slug)}`;
      return `<a class="${cls}" href="${escapeAttr(href)}" data-agent-slug="${escapeAttr(agent.slug)}">${escapeHtml(agent.name)}</a>`;
    })
    .join('');
  return `<nav class="plan-picker" aria-label="Select agent">${items}</nav>`;
}

/**
 * Render the selected agent's plan.md — or a friendly empty state when
 * the file is absent or empty.
 *
 * @param {{ slug: string, name: string, markdown: string | null, hasPlan: boolean } | null} selected
 * @returns {string}
 */
function renderPlanBody(selected) {
  if (!selected) {
    return `<div class="plan-empty">Select an agent to view its plan.</div>`;
  }
  if (!selected.hasPlan) {
    return [
      `<div class="plan-empty">`,
      `No <code>plan.md</code> yet for <strong>${escapeHtml(selected.name)}</strong>.`,
      ` Run <code>/aweek:plan</code> to draft long-term goals, monthly plans, and strategies.`,
      `</div>`,
    ].join('');
  }
  const rendered = renderMarkdown(selected.markdown);
  return `<article class="plan-body" data-agent-slug="${escapeAttr(selected.slug)}">${rendered}</article>`;
}

/**
 * Minimal markdown → HTML renderer covering the subset that plan.md
 * files actually use. Supports:
 *
 *   - ATX headings (`#` … `####`)
 *   - Paragraphs (blank-line separated blocks)
 *   - Unordered lists (`-` or `*`)
 *   - Ordered lists (`1.`, `2.`, …)
 *   - Fenced code blocks (```lang … ```)
 *   - Blockquotes (`>`)
 *   - Inline `**bold**`, `*italic*`, `` `code` ``, and `[text](url)`
 *   - HTML comments (`<!-- … -->`) are stripped so the canonical
 *     template's `<!-- placeholder -->` hints don't leak to readers.
 *
 * Every dynamic substring is HTML-escaped before any markdown syntax
 * is consumed, so the output is safe for direct injection into the
 * dashboard shell.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function renderMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';

  // 1. Strip HTML comments first — they span lines and we never want
  //    them to reach the reader. Using a non-greedy match so multiple
  //    comments on one line don't collapse into one.
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Split on fenced code blocks and handle each chunk independently:
  //    fenced chunks preserve content verbatim (escaped); non-fenced
  //    chunks go through the block-level renderer.
  const out = [];
  const fenceRe = /```(\w*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fenceRe.exec(withoutComments)) !== null) {
    const before = withoutComments.slice(lastIndex, match.index);
    if (before.length > 0) out.push(renderBlocks(before));
    const lang = (match[1] || '').trim();
    const code = match[2];
    const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : '';
    out.push(
      `<pre class="plan-code"><code${langAttr}>${escapeHtml(code)}</code></pre>`,
    );
    lastIndex = match.index + match[0].length;
  }
  const tail = withoutComments.slice(lastIndex);
  if (tail.length > 0) out.push(renderBlocks(tail));

  return out.join('');
}

/**
 * Render a markdown fragment that contains no fenced code blocks.
 * Splits the input into block-level groups (heading, list, blockquote,
 * paragraph) based on blank-line boundaries.
 *
 * @param {string} md
 * @returns {string}
 */
function renderBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  const isHeading = (line) => /^#{1,6}\s+/.test(line);
  const isUnorderedItem = (line) => /^\s*[-*]\s+/.test(line);
  const isOrderedItem = (line) => /^\s*\d+\.\s+/.test(line);
  const isBlockquote = (line) => /^\s*>\s?/.test(line);
  const isBlank = (line) => /^\s*$/.test(line);

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    if (isHeading(line)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      const level = Math.min(m[1].length, 4); // clamp: H4 is our deepest styled heading
      blocks.push(`<h${level} class="plan-h${level}">${renderInline(m[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (isUnorderedItem(line)) {
      const items = [];
      while (i < lines.length && isUnorderedItem(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      const lis = items.map((t) => `<li>${renderInline(t)}</li>`).join('');
      blocks.push(`<ul class="plan-list">${lis}</ul>`);
      continue;
    }

    if (isOrderedItem(line)) {
      const items = [];
      while (i < lines.length && isOrderedItem(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      const lis = items.map((t) => `<li>${renderInline(t)}</li>`).join('');
      blocks.push(`<ol class="plan-list">${lis}</ol>`);
      continue;
    }

    if (isBlockquote(line)) {
      const quoted = [];
      while (i < lines.length && isBlockquote(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      // Recursively render the quoted body so nested lists/headings
      // inside a blockquote still work.
      blocks.push(`<blockquote class="plan-quote">${renderBlocks(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    // Paragraph: collect consecutive non-blank, non-block-opening lines.
    const para = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !isHeading(lines[i]) &&
      !isUnorderedItem(lines[i]) &&
      !isOrderedItem(lines[i]) &&
      !isBlockquote(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) {
      blocks.push(`<p class="plan-p">${renderInline(para.join(' '))}</p>`);
    }
  }

  return blocks.join('');
}

/**
 * Render inline markdown (bold, italic, inline code, links). Runs on
 * already-escaped text so raw `<`, `>`, `&` from the source survive as
 * entities and cannot inject HTML.
 *
 * Order matters: inline code is extracted first (its content is
 * exempted from further transforms), then links, then bold, then
 * italic. Emphasis uses the greedy-longest-first pattern (`**…**`
 * before `*…*`) so `**bold with *italic* inside**` does the right
 * thing.
 *
 * @param {string} text
 * @returns {string}
 */
function renderInline(text) {
  // Escape HTML up front so every downstream transform operates on
  // entity-safe text.
  let escaped = escapeHtml(text);

  // Inline code: replace with placeholders, then restore at the end so
  // bold/italic/link rules can't touch the code content.
  const codes = [];
  escaped = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codes.length;
    codes.push(code);
    return `\u0000CODE${idx}\u0000`;
  });

  // Links: `[text](url)` — url is HTML-escaped already, so the href is
  // safe. We do NOT open links in a new tab by default; dashboard users
  // stay in-place and can cmd-click to pop out.
  escaped = escaped.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label, url) => `<a class="plan-link" href="${url}">${label}</a>`,
  );

  // Bold first (longest emphasis) then italic. Using non-greedy bodies
  // so two emphasis spans on one line don't merge.
  escaped = escaped.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');

  // Restore inline code placeholders.
  escaped = escaped.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => {
    return `<code class="plan-code-inline">${codes[Number(i)]}</code>`;
  });

  return escaped;
}

/**
 * CSS fragment for the plan card. Tokens come from the shell (`--bg`,
 * `--panel`, `--border`, …) so the plan styles automatically track any
 * future theme changes in `renderDashboardShell`.
 *
 * @returns {string}
 */
export function planSectionStyles() {
  return `
  .plan-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .plan-pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--muted);
    font-size: 12px;
    text-decoration: none;
    letter-spacing: 0.01em;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .plan-pill:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .plan-pill.selected {
    color: var(--text);
    border-color: var(--accent);
    background: rgba(138, 180, 255, 0.1);
    font-weight: 600;
  }
  .plan-body {
    font-size: 13.5px;
    line-height: 1.55;
  }
  .plan-body > *:first-child { margin-top: 0; }
  .plan-body > *:last-child { margin-bottom: 0; }
  .plan-h1, .plan-h2, .plan-h3, .plan-h4 {
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    margin: 18px 0 6px;
  }
  .plan-h1 { font-size: 17px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .plan-h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin-top: 20px;
  }
  .plan-h3 { font-size: 13.5px; color: var(--accent); }
  .plan-h4 { font-size: 13px; color: var(--muted); }
  .plan-p { margin: 8px 0; color: var(--text); }
  .plan-list {
    margin: 8px 0;
    padding-left: 22px;
    color: var(--text);
  }
  .plan-list li { margin: 3px 0; }
  .plan-quote {
    margin: 10px 0;
    padding: 4px 12px;
    border-left: 3px solid var(--border);
    color: var(--muted);
    background: rgba(138, 180, 255, 0.04);
  }
  .plan-link {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px dotted currentColor;
  }
  .plan-link:hover { border-bottom-style: solid; }
  .plan-code {
    margin: 10px 0;
    padding: 10px 12px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow-x: auto;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    color: var(--text);
  }
  .plan-code code {
    background: transparent;
    padding: 0;
    font-size: inherit;
  }
  .plan-code-inline {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    background: rgba(138, 180, 255, 0.1);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .plan-empty {
    color: var(--muted);
    font-style: italic;
  }
  .plan-empty strong { color: var(--text); font-style: normal; }
  `;
}

// ---------------------------------------------------------------------------
// HTML escaping — local copy so this module can be tested in isolation
// without pulling server.js in.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
