/**
 * Tests for `./tool-invocation-block.tsx` — the inline tool-invocation
 * collapsible shipped in Sub-AC 1 of AC 3.
 *
 * Coverage:
 *   - Default render is collapsed: chevron is non-rotated, body is
 *     hidden, only the header renders.
 *   - Header surfaces the tool name verbatim and the truncated args
 *     summary derived from `args` / `summary`.
 *   - Clicking the header toggles `aria-expanded` and reveals the body.
 *   - `defaultExpanded` honours the initial state.
 *   - `summarizeToolArgs` truncates and formats correctly.
 *   - `aria-controls` wires the header to the body id when a body is
 *     present, and is omitted when not.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  ToolInvocationBlock,
  ToolInvocationBody,
  TOOL_INVOCATION_SUMMARY_MAX_LENGTH,
  summarizeToolArgs,
} from './tool-invocation-block.tsx';

afterEach(() => {
  cleanup();
});

describe('ToolInvocationBlock — render', () => {
  it('renders collapsed by default with the tool name visible', () => {
    render(
      <ToolInvocationBlock name="Read" args={{ file_path: '/tmp/foo.txt' }}>
        <pre>full body</pre>
      </ToolInvocationBlock>,
    );

    const header = screen.getByRole('button');
    expect(header).toHaveAttribute('aria-expanded', 'false');

    // Header shows the tool name verbatim.
    expect(header).toHaveTextContent('Read');

    // Body is rendered but hidden via the `hidden` attribute.
    const body = document.querySelector(
      '[data-component="chat-tool-invocation-body"]',
    );
    expect(body).not.toBeNull();
    expect(body?.hasAttribute('hidden')).toBe(true);

    // Outer state attribute is collapsed.
    const root = document.querySelector(
      '[data-component="chat-tool-invocation"]',
    );
    expect(root?.getAttribute('data-state')).toBe('collapsed');
  });

  it('renders the truncated args summary in the header', () => {
    render(
      <ToolInvocationBlock
        name="Read"
        args={{ file_path: '/tmp/foo.txt' }}
      />,
    );

    // The summary turns the args object into a one-line readable
    // string. We don't pin the exact whitespace but assert both the
    // key and a quoted slice of the value are visible.
    const summary = document.querySelector(
      '[data-component="chat-tool-invocation-summary"]',
    );
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('file_path');
    expect(summary?.textContent).toContain('/tmp/foo.txt');
  });

  it('honours an explicit `summary` prop over auto-derived args', () => {
    render(
      <ToolInvocationBlock
        name="Bash"
        args={{ command: 'ls -la' }}
        summary="listing the working directory"
      />,
    );
    const summary = document.querySelector(
      '[data-component="chat-tool-invocation-summary"]',
    );
    expect(summary?.textContent).toBe('listing the working directory');
    // The original args should NOT leak into the summary slot.
    expect(summary?.textContent).not.toContain('command');
  });

  it('hides the summary span entirely when args are empty', () => {
    render(<ToolInvocationBlock name="NoArgs" args={{}} />);
    const summary = document.querySelector(
      '[data-component="chat-tool-invocation-summary"]',
    );
    expect(summary).toBeNull();
  });

  it('omits aria-controls when no body is provided', () => {
    render(<ToolInvocationBlock name="Read" args={{}} />);
    const header = screen.getByRole('button');
    expect(header.hasAttribute('aria-controls')).toBe(false);

    // No body element rendered either.
    const body = document.querySelector(
      '[data-component="chat-tool-invocation-body"]',
    );
    expect(body).toBeNull();
  });

  it('wires aria-controls to the body id when a body is provided', () => {
    render(
      <ToolInvocationBlock name="Read" args={{}}>
        <span>body content</span>
      </ToolInvocationBlock>,
    );
    const header = screen.getByRole('button');
    const controlsId = header.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    const body = document.getElementById(controlsId as string);
    expect(body).not.toBeNull();
    expect(body?.getAttribute('data-component')).toBe(
      'chat-tool-invocation-body',
    );
  });
});

describe('ToolInvocationBlock — toggle behaviour', () => {
  it('expands and collapses on header click', () => {
    render(
      <ToolInvocationBlock name="Read" args={{ file_path: '/tmp/x' }}>
        <pre>contents</pre>
      </ToolInvocationBlock>,
    );

    const header = screen.getByRole('button');
    expect(header).toHaveAttribute('aria-expanded', 'false');

    // First click → expanded.
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');

    const root = document.querySelector(
      '[data-component="chat-tool-invocation"]',
    );
    expect(root?.getAttribute('data-state')).toBe('expanded');

    const body = document.querySelector(
      '[data-component="chat-tool-invocation-body"]',
    );
    expect(body?.hasAttribute('hidden')).toBe(false);

    const chevron = document.querySelector(
      '[data-component="chat-tool-invocation-chevron"]',
    );
    expect(chevron?.getAttribute('class')).toMatch(/rotate-90/);

    // Second click → collapsed again.
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(root?.getAttribute('data-state')).toBe('collapsed');
    expect(body?.hasAttribute('hidden')).toBe(true);
  });

  it('respects defaultExpanded={true}', () => {
    render(
      <ToolInvocationBlock name="Read" args={{}} defaultExpanded>
        <span>body</span>
      </ToolInvocationBlock>,
    );
    const header = screen.getByRole('button');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const body = document.querySelector(
      '[data-component="chat-tool-invocation-body"]',
    );
    expect(body?.hasAttribute('hidden')).toBe(false);
  });
});

describe('summarizeToolArgs', () => {
  it('returns empty string for nullish or empty input', () => {
    expect(summarizeToolArgs(null)).toBe('');
    expect(summarizeToolArgs(undefined)).toBe('');
    expect(summarizeToolArgs({})).toBe('');
  });

  it('formats a single-key object as `key: "value"`', () => {
    expect(summarizeToolArgs({ file_path: '/tmp/foo.txt' })).toBe(
      'file_path: "/tmp/foo.txt"',
    );
  });

  it('comma-joins multi-key objects in input order', () => {
    expect(
      summarizeToolArgs({ command: 'ls', timeout: 30 }),
    ).toBe('command: "ls", timeout: 30');
  });

  it('truncates with an ellipsis past the cap', () => {
    const long = 'x'.repeat(TOOL_INVOCATION_SUMMARY_MAX_LENGTH * 2);
    const result = summarizeToolArgs({ blob: long });
    expect(result.length).toBeLessThanOrEqual(
      TOOL_INVOCATION_SUMMARY_MAX_LENGTH,
    );
    expect(result.endsWith('…')).toBe(true);
  });

  it('flattens whitespace inside string values so the header stays single-line', () => {
    const result = summarizeToolArgs({
      content: 'line one\nline two\n\nline three',
    });
    expect(result).not.toContain('\n');
    // The flattened content should still be readable.
    expect(result).toContain('line one line two line three');
  });

  it('handles primitive args gracefully', () => {
    expect(summarizeToolArgs(42)).toBe('42');
    expect(summarizeToolArgs(true)).toBe('true');
    expect(summarizeToolArgs('hi')).toBe('"hi"');
  });

  it('falls back to [object] for circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // Wrap so the top-level object is visible but the value cannot
    // be JSON-stringified.
    const result = summarizeToolArgs({ ref: circular });
    expect(result).toContain('ref:');
    expect(result).toContain('[object]');
  });
});

// ── Sub-AC 2 of AC 3: ToolInvocationBody ──────────────────────────────

describe('ToolInvocationBody — args section (pretty-printed JSON)', () => {
  it('renders args as 2-space indented JSON inside a <pre>', () => {
    render(
      <ToolInvocationBody
        args={{ file_path: '/tmp/foo.txt', limit: 100 }}
        state="success"
        result="ok"
      />,
    );

    const argsPre = document.querySelector(
      '[data-component="chat-tool-invocation-args-pre"]',
    );
    expect(argsPre).not.toBeNull();
    expect(argsPre?.tagName.toLowerCase()).toBe('pre');

    // The body must show the full payload (not the truncated summary).
    const text = argsPre?.textContent ?? '';
    expect(text).toContain('"file_path"');
    expect(text).toContain('"/tmp/foo.txt"');
    expect(text).toContain('"limit"');
    expect(text).toContain('100');

    // 2-space indent — every key sits on its own line so a multi-key
    // payload reads vertically rather than collapsing to one line.
    expect(text).toMatch(/\n\s{2}"file_path"/);
  });

  it('omits the args section when args is null/undefined/empty', () => {
    const { rerender } = render(
      <ToolInvocationBody state="success" result="ok" />,
    );
    expect(
      document.querySelector('[data-component="chat-tool-invocation-args"]'),
    ).toBeNull();

    rerender(
      <ToolInvocationBody args={null} state="success" result="ok" />,
    );
    expect(
      document.querySelector('[data-component="chat-tool-invocation-args"]'),
    ).toBeNull();

    rerender(<ToolInvocationBody args={{}} state="success" result="ok" />);
    expect(
      document.querySelector('[data-component="chat-tool-invocation-args"]'),
    ).toBeNull();

    rerender(<ToolInvocationBody args={[]} state="success" result="ok" />);
    expect(
      document.querySelector('[data-component="chat-tool-invocation-args"]'),
    ).toBeNull();
  });

  it('falls back to [unserialisable] for circular args', () => {
    const circular: Record<string, unknown> = { name: 'self' };
    circular.self = circular;
    render(<ToolInvocationBody args={circular} state="success" />);
    const argsPre = document.querySelector(
      '[data-component="chat-tool-invocation-args-pre"]',
    );
    expect(argsPre?.textContent).toBe('[unserialisable]');
  });
});

describe('ToolInvocationBody — pending state', () => {
  it('renders a spinner + "Running…" placeholder', () => {
    render(<ToolInvocationBody state="pending" args={{ file_path: '/x' }} />);

    const pending = document.querySelector(
      '[data-component="chat-tool-invocation-pending"]',
    );
    expect(pending).not.toBeNull();
    expect(pending?.textContent).toContain('Running');
    // role="status" makes the streaming announcement available to ATs.
    expect(pending?.getAttribute('role')).toBe('status');

    // Outer marker reflects the state for CSS / tests to pin.
    const outer = document.querySelector(
      '[data-component="chat-tool-invocation-body-content"]',
    );
    expect(outer?.getAttribute('data-state')).toBe('pending');

    // Success / error markers must NOT render in the pending state.
    expect(
      document.querySelector('[data-component="chat-tool-invocation-success"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-component="chat-tool-invocation-error"]'),
    ).toBeNull();
  });
});

describe('ToolInvocationBody — success state', () => {
  it('renders the formatted result inside a <pre>', () => {
    render(<ToolInvocationBody state="success" result="hello world" />);
    const success = document.querySelector(
      '[data-component="chat-tool-invocation-success"]',
    );
    expect(success).not.toBeNull();
    expect(success?.tagName.toLowerCase()).toBe('pre');
    expect(success?.textContent).toBe('hello world');
  });

  it('JSON-formats non-string results', () => {
    render(
      <ToolInvocationBody
        state="success"
        result={{ files: ['a.ts', 'b.ts'] }}
      />,
    );
    const success = document.querySelector(
      '[data-component="chat-tool-invocation-success"]',
    );
    const text = success?.textContent ?? '';
    expect(text).toContain('"files"');
    expect(text).toContain('"a.ts"');
    expect(text).toContain('"b.ts"');
  });

  it('shows "(no output)" when the result is empty/nullish', () => {
    const { rerender } = render(<ToolInvocationBody state="success" />);
    expect(
      document.querySelector(
        '[data-component="chat-tool-invocation-success-empty"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-component="chat-tool-invocation-success"]'),
    ).toBeNull();

    rerender(<ToolInvocationBody state="success" result={null} />);
    expect(
      document.querySelector(
        '[data-component="chat-tool-invocation-success-empty"]',
      ),
    ).not.toBeNull();

    rerender(<ToolInvocationBody state="success" result="" />);
    expect(
      document.querySelector(
        '[data-component="chat-tool-invocation-success-empty"]',
      ),
    ).not.toBeNull();
  });

  it('defaults to "success" when state is omitted', () => {
    render(<ToolInvocationBody result="42" />);
    const outer = document.querySelector(
      '[data-component="chat-tool-invocation-body-content"]',
    );
    expect(outer?.getAttribute('data-state')).toBe('success');
    const success = document.querySelector(
      '[data-component="chat-tool-invocation-success"]',
    );
    expect(success?.textContent).toBe('42');
  });
});

describe('ToolInvocationBody — error state', () => {
  it('renders destructive-tinted block with role="alert"', () => {
    render(
      <ToolInvocationBody
        state="error"
        errorMessage="ENOENT: file not found"
      />,
    );

    const errorBlock = document.querySelector(
      '[data-component="chat-tool-invocation-error"]',
    );
    expect(errorBlock).not.toBeNull();
    expect(errorBlock?.getAttribute('role')).toBe('alert');
    expect(errorBlock?.textContent).toContain('ENOENT: file not found');

    // Destructive theme tokens must show up so the visual contract is
    // pinned (light/dark themes pick up the destructive palette).
    expect(errorBlock?.className).toMatch(/destructive/);

    // Pending / success markers must NOT render in the error state.
    expect(
      document.querySelector('[data-component="chat-tool-invocation-pending"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-component="chat-tool-invocation-success"]'),
    ).toBeNull();
  });

  it('uses errorMessage when both errorMessage and result are set', () => {
    render(
      <ToolInvocationBody
        state="error"
        errorMessage="explicit error"
        result="raw result"
      />,
    );
    const message = document.querySelector(
      '[data-component="chat-tool-invocation-error-message"]',
    );
    expect(message?.textContent).toBe('explicit error');
  });

  it('falls back to formatted result when errorMessage is omitted', () => {
    render(
      <ToolInvocationBody
        state="error"
        result={{ code: 'ENOENT', path: '/tmp/x' }}
      />,
    );
    const message = document.querySelector(
      '[data-component="chat-tool-invocation-error-message"]',
    );
    const text = message?.textContent ?? '';
    expect(text).toContain('"code"');
    expect(text).toContain('"ENOENT"');
  });

  it('falls back to "Tool invocation failed." when nothing useful is available', () => {
    render(<ToolInvocationBody state="error" />);
    const message = document.querySelector(
      '[data-component="chat-tool-invocation-error-message"]',
    );
    expect(message?.textContent).toBe('Tool invocation failed.');
  });
});

// ── ToolInvocationBlock auto-body integration ─────────────────────────

describe('ToolInvocationBlock — auto-render body when state/result/errorMessage are set', () => {
  it('auto-renders the canonical body in success state', () => {
    render(
      <ToolInvocationBlock
        name="Read"
        args={{ file_path: '/tmp/foo.txt' }}
        state="success"
        result={'line one\nline two'}
        defaultExpanded
      />,
    );

    // Args section should pretty-print the payload.
    const argsPre = document.querySelector(
      '[data-component="chat-tool-invocation-args-pre"]',
    );
    expect(argsPre?.textContent).toContain('"file_path"');

    // Result section should render the success block.
    const success = document.querySelector(
      '[data-component="chat-tool-invocation-success"]',
    );
    expect(success?.textContent).toBe('line one\nline two');
  });

  it('auto-renders the body in pending state', () => {
    render(
      <ToolInvocationBlock
        name="Bash"
        args={{ command: 'sleep 5' }}
        state="pending"
        defaultExpanded
      />,
    );
    expect(
      document.querySelector('[data-component="chat-tool-invocation-pending"]'),
    ).not.toBeNull();
  });

  it('auto-renders the body in error state', () => {
    render(
      <ToolInvocationBlock
        name="Read"
        args={{ file_path: '/missing' }}
        state="error"
        errorMessage="ENOENT"
        defaultExpanded
      />,
    );
    const errorBlock = document.querySelector(
      '[data-component="chat-tool-invocation-error"]',
    );
    expect(errorBlock?.textContent).toContain('ENOENT');
  });

  it('prefers explicit children over auto-rendered body', () => {
    render(
      <ToolInvocationBlock
        name="Read"
        args={{ file_path: '/tmp/x' }}
        state="success"
        result="raw"
        defaultExpanded
      >
        <div data-testid="custom-body">custom</div>
      </ToolInvocationBlock>,
    );

    // Children win.
    expect(screen.getByTestId('custom-body')).toBeTruthy();
    // Auto-body markers must NOT render alongside.
    expect(
      document.querySelector(
        '[data-component="chat-tool-invocation-body-content"]',
      ),
    ).toBeNull();
  });

  it('does not render a body when neither children nor body props are provided', () => {
    render(<ToolInvocationBlock name="Read" args={{ file_path: '/x' }} />);
    expect(
      document.querySelector('[data-component="chat-tool-invocation-body"]'),
    ).toBeNull();
    const header = screen.getByRole('button');
    expect(header.hasAttribute('aria-controls')).toBe(false);
  });
});
