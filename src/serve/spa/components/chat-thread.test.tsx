/**
 * Tests for `./chat-thread.tsx` — the chat-surface component shipped
 * in Sub-AC 3 of the chat-panel feature (AC 1).
 *
 * The hook (`useChatStream`) has its own deep coverage — these tests
 * focus on the surface integration:
 *   1. The composer renders a textarea + Send button anchored to the
 *      panel footer.
 *   2. Submitting the form fires a fetch to `/api/chat` with the
 *      typed text appended as the latest user message.
 *   3. The user message bubble renders immediately after submit
 *      (optimistic update from the hook).
 *   4. While streaming, the Send button swaps to a Stop button.
 *   5. The header surfaces the agent slug as the panel title and a
 *      streaming-status indicator.
 *
 * Vitest + jsdom + Testing Library (config: vitest.config.js +
 * vitest.setup.js).
 */

import * as React from 'react';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { ChatPanel } from './chat-panel.tsx';
import { ChatThread } from './chat-thread.tsx';

afterEach(() => {
  cleanup();
});

/**
 * Build a minimal streaming Response so the hook's reader path
 * exercises end-to-end. Returns a `push`/`end` pair so tests can drip
 * SSE frames in deterministically.
 */
function makeStreamingResponse(): {
  response: Response;
  push: (chunk: string) => void;
  end: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: stream,
      text: async () => '',
    } as unknown as Response,
    push(chunk: string) {
      controller?.enqueue(encoder.encode(chunk));
    },
    end() {
      controller?.close();
    },
  };
}

describe('ChatThread — composer + submit', () => {
  it('renders a labelled textarea and a Send button by default', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread slug="writer" fetch={vi.fn() as unknown as typeof fetch} />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i);
    expect(textarea.tagName).toBe('TEXTAREA');

    const send = screen.getByRole('button', { name: /send message/i });
    expect(send).toHaveAttribute('type', 'submit');
    // Disabled while empty — nothing to send.
    expect(send).toBeDisabled();
  });

  it('POSTs the typed message to /api/chat on submit', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      // Defer end so the hook can flip to streaming before settling.
      queueMicrotask(() => stream.end());
      return stream.response;
    });

    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={fetchMock as unknown as typeof fetch}
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello agent' } });

    const send = screen.getByRole('button', { name: /send message/i });
    await act(async () => {
      fireEvent.click(send);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/chat');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.slug).toBe('writer');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'hello agent' });
  });

  it('renders the user message bubble immediately on submit (optimistic)', async () => {
    let resolveResponse: (r: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((res) => {
          resolveResponse = res;
        }),
    );

    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={fetchMock as unknown as typeof fetch}
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'visible immediately' } });

    act(() => {
      fireEvent.submit(textarea.closest('form')!);
    });

    await waitFor(() => {
      expect(screen.getByText('visible immediately')).toBeInTheDocument();
    });

    // Resolve to let the hook settle so unmount doesn't yell.
    const stream = makeStreamingResponse();
    await act(async () => {
      resolveResponse(stream.response);
      stream.end();
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  it('swaps the Send button for a Stop button while streaming', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={fetchMock as unknown as typeof fetch}
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'long task' } });
    fireEvent.submit(textarea.closest('form')!);

    // While the stream is still open, the Stop button replaces Send.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /stop streaming/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /send message/i }),
    ).toBeNull();

    // Stop and let the hook settle.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop streaming/i }));
      stream.end();
      await new Promise((r) => setTimeout(r, 10));
    });
  });
});

// ── Sub-AC 4 of AC 7: Budget-exhausted gating ──────────────────────────

describe('ChatThread — budget-exhausted state', () => {
  it('renders the canonical banner copy when budgetExhausted=true', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={vi.fn() as unknown as typeof fetch}
          budgetExhausted
        />
      </ChatPanel>,
    );

    const banner = document.querySelector(
      '[data-component="chat-thread-budget-banner"]',
    );
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain(
      'Weekly budget exhausted — resume via aweek manage',
    );
  });

  it('disables the textarea and the Send button when budgetExhausted=true', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={vi.fn() as unknown as typeof fetch}
          budgetExhausted
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(textarea.placeholder).toContain('Weekly budget exhausted');

    const send = screen.getByRole('button', { name: /send message/i });
    expect(send).toBeDisabled();
  });

  it('does not render the banner when budgetExhausted is omitted', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread slug="writer" fetch={vi.fn() as unknown as typeof fetch} />
      </ChatPanel>,
    );
    expect(
      document.querySelector('[data-component="chat-thread-budget-banner"]'),
    ).toBeNull();
  });

  it('appends the structured message when a verdict object is provided', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={vi.fn() as unknown as typeof fetch}
          budgetExhausted={{
            reason: 'budget_exhausted',
            agentId: 'writer',
            weekMonday: '2026-04-13',
            used: 1500,
            budget: 1000,
            remaining: 0,
            paused: false,
            message:
              'Agent "writer" has exhausted its weekly token budget. ' +
              'Used 1500 of 1000 tokens (week 2026-04-13, over by 500).',
          }}
        />
      </ChatPanel>,
    );

    const banner = document.querySelector(
      '[data-component="chat-thread-budget-banner"]',
    );
    expect(banner!.textContent).toContain(
      'Weekly budget exhausted — resume via aweek manage',
    );
    const detail = document.querySelector(
      '[data-component="chat-thread-budget-banner-detail"]',
    );
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('Used 1500 of 1000 tokens');
  });

  it('flips into budget-exhausted state when the server emits a budget-exhausted SSE frame', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={fetchMock as unknown as typeof fetch}
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'over budget?' } });

    await act(async () => {
      fireEvent.submit(textarea.closest('form')!);
      // Let the fetch microtask settle
      await new Promise((r) => setTimeout(r, 0));
    });

    // Push a budget-exhausted frame from the server.
    const frame = JSON.stringify({
      type: 'budget-exhausted',
      reason: 'budget_exhausted',
      agentId: 'writer',
      weekMonday: '2026-04-13',
      used: 1500,
      budget: 1000,
      remaining: 0,
      paused: false,
      message: 'over budget — resume via aweek manage',
    });

    await act(async () => {
      stream.push(`data: ${frame}\n\n`);
      stream.end();
      await new Promise((r) => setTimeout(r, 20));
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-component="chat-thread-budget-banner"]'),
      ).not.toBeNull();
    });

    // Composer is now locked.
    expect(textarea).toBeDisabled();
  });
});

describe('ChatThread — header status', () => {
  it('renders the slug as the title by default', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread slug="writer" fetch={vi.fn() as unknown as typeof fetch} />
      </ChatPanel>,
    );
    const title = document.querySelector('[data-component="chat-thread-title"]');
    expect(title?.textContent).toBe('writer');
  });

  it('renders a custom title when provided', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          title="Writer Agent"
          fetch={vi.fn() as unknown as typeof fetch}
        />
      </ChatPanel>,
    );
    const title = document.querySelector('[data-component="chat-thread-title"]');
    expect(title?.textContent).toBe('Writer Agent');
  });

  it('shows the empty-state when no messages have been sent yet', () => {
    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread slug="writer" fetch={vi.fn() as unknown as typeof fetch} />
      </ChatPanel>,
    );
    expect(
      document.querySelector('[data-component="chat-thread-empty"]'),
    ).not.toBeNull();
  });
});

// ── Sub-AC 3 of AC 3: ToolInvocationBlock inline rendering ──────────────

describe('ChatThread — tool invocation parts rendering', () => {
  it('renders a tool-invocation part inline as a ToolInvocationBlock', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={fetchMock as unknown as typeof fetch}
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'check it' } });

    await act(async () => {
      fireEvent.submit(textarea.closest('form')!);
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      stream.push(
        `data: ${JSON.stringify({ type: 'text-delta', delta: 'Let me read it. ' })}\n\n`,
      );
      stream.push(
        `data: ${JSON.stringify({
          type: 'tool-use',
          toolUseId: 'tu_render_1',
          name: 'Read',
          input: { file_path: '/tmp/foo.txt' },
        })}\n\n`,
      );
      stream.push(
        `data: ${JSON.stringify({
          type: 'tool-result',
          toolUseId: 'tu_render_1',
          content: 'file contents here',
          isError: false,
        })}\n\n`,
      );
      stream.push(
        `data: ${JSON.stringify({ type: 'text-delta', delta: 'Got it.' })}\n\n`,
      );
      stream.end();
      await new Promise((r) => setTimeout(r, 20));
    });

    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-component="chat-tool-invocation"][data-tool-name="Read"]',
        ),
      ).not.toBeNull();
    });

    // Tool block carries the wire toolUseId so it can be matched in
    // future updates.
    const block = document.querySelector(
      '[data-component="chat-tool-invocation"]',
    );
    expect(block?.getAttribute('data-tool-use-id')).toBe('tu_render_1');

    // Header surfaces the tool name + args summary.
    const summary = block?.querySelector(
      '[data-component="chat-tool-invocation-summary"]',
    );
    expect(summary?.textContent).toContain('file_path');
    expect(summary?.textContent).toContain('/tmp/foo.txt');

    // The bracketing text parts render as separate bubbles in arrival
    // order so the tool block is sandwiched between them.
    const messageEl = document.querySelector(
      '[data-component="chat-thread-message"][data-role="assistant"]',
    );
    expect(messageEl).not.toBeNull();
    const children = Array.from(messageEl?.children ?? []);
    const types = children.map((c) =>
      c.getAttribute('data-component') ??
      (c.querySelector('[data-component]')?.getAttribute('data-component') ?? ''),
    );
    // Expect text → tool → text.
    expect(types[0]).toBe('chat-thread-message-text');
    expect(types[1]).toBe('chat-tool-invocation');
    expect(types[2]).toBe('chat-thread-message-text');

    // Both text bubbles are visible.
    expect(screen.getByText('Let me read it.')).toBeInTheDocument();
    expect(screen.getByText('Got it.')).toBeInTheDocument();
  });

  it('renders a pending tool-invocation while the result is in flight', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={fetchMock as unknown as typeof fetch}
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'slow tool' } });

    await act(async () => {
      fireEvent.submit(textarea.closest('form')!);
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      stream.push(
        `data: ${JSON.stringify({
          type: 'tool-use',
          toolUseId: 'tu_pending',
          name: 'Bash',
          input: { command: 'sleep 60' },
        })}\n\n`,
      );
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-component="chat-tool-invocation"]'),
      ).not.toBeNull();
    });

    // Expand the block to inspect the body.
    const header = screen.getByRole('button', { name: /Bash/ });
    fireEvent.click(header);

    expect(
      document.querySelector('[data-component="chat-tool-invocation-pending"]'),
    ).not.toBeNull();

    // Settle the stream so unmount doesn't yell.
    await act(async () => {
      stream.end();
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  it('renders a tool-invocation in error state when isError=true', async () => {
    const stream = makeStreamingResponse();
    const fetchMock = vi.fn<typeof fetch>(async () => stream.response);

    render(
      <ChatPanel open animationDuration={0}>
        <ChatThread
          slug="writer"
          fetch={fetchMock as unknown as typeof fetch}
        />
      </ChatPanel>,
    );

    const textarea = screen.getByLabelText(/Message writer/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'bad tool' } });

    await act(async () => {
      fireEvent.submit(textarea.closest('form')!);
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      stream.push(
        `data: ${JSON.stringify({
          type: 'tool-use',
          toolUseId: 'tu_err',
          name: 'Read',
          input: { file_path: '/nope' },
        })}\n\n`,
      );
      stream.push(
        `data: ${JSON.stringify({
          type: 'tool-result',
          toolUseId: 'tu_err',
          content: 'ENOENT',
          isError: true,
        })}\n\n`,
      );
      stream.end();
      await new Promise((r) => setTimeout(r, 20));
    });

    // Expand to show the error.
    await waitFor(() => {
      expect(
        document.querySelector('[data-component="chat-tool-invocation"]'),
      ).not.toBeNull();
    });

    const header = screen.getByRole('button', { name: /Read/ });
    fireEvent.click(header);

    const errorBlock = document.querySelector(
      '[data-component="chat-tool-invocation-error"]',
    );
    expect(errorBlock).not.toBeNull();
    expect(errorBlock?.textContent).toContain('ENOENT');
  });
});
