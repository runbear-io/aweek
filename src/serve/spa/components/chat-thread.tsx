/**
 * `ChatThread` — chat surface that wires the {@link useChatStream}
 * transport hook into the {@link ChatPanel} composable shell.
 *
 * Sub-AC 3 of AC 1: this is the concrete chat surface that mounts in
 * the floating-bubble's body slot. It composes the existing primitives:
 *
 *   - {@link useChatStream}   — POST + SSE-streaming transport (Sub-AC 3)
 *   - {@link ChatPanelHeader}, {@link ChatPanelBody},
 *     {@link ChatPanelFooter} — composable shell regions (Sub-AC 2)
 *   - shadcn `Button`         — Send / Stop buttons matching the rest
 *                               of the dashboard chrome
 *
 * The component is intentionally minimal in v1 — it covers the
 * acceptance bar of "POST user message and begin reading SSE stream on
 * submit" with a usable but unstyled message list. Subsequent sub-ACs
 * layer:
 *
 *   - tool-invocation rendering (collapsible, matching Claude CLI)
 *   - thread-list switcher in the header
 *   - system preamble banner with budget / week info
 *   - retry / regenerate affordances
 *
 * Layout:
 *   - Header: agent label + status badge ('streaming…' while in flight).
 *   - Body:   reverse-chronological message list (top → bottom oldest →
 *             newest), auto-scrolling to the bottom on new messages so
 *             the latest reply is always in view.
 *   - Footer: textarea composer + Send button. While streaming the Send
 *             button swaps to a destructive Stop button so users can
 *             cancel without leaving the panel.
 *
 * Accessibility:
 *   - Composer is a real `<form>` so Enter submits naturally.
 *   - Textarea is a labelled `<textarea>` with `aria-label`.
 *   - Stop button has its own `aria-label` distinct from Send so
 *     screen readers can tell them apart in the same DOM position.
 *
 * Styling follows project policy: shadcn theme tokens only
 * (`bg-card`, `text-card-foreground`, `text-muted-foreground`, …) — no
 * hardcoded colour classes — so the surface re-themes automatically
 * with light/dark.
 *
 * @module serve/spa/components/chat-thread
 */

import * as React from 'react';
import { AlertTriangle, Loader2, Send, Square } from 'lucide-react';

import * as ButtonModule from './ui/button.jsx';
import { cn } from '../lib/cn.js';
import { Markdown } from '../lib/markdown.js';
import {
  useChatStream,
  type BudgetExhaustedInfo,
  type ChatStatus,
  type ChatUIMessage,
  type ChatUIMessagePart,
  type UseChatStreamOptions,
} from '../hooks/use-chat-stream.js';
import {
  ChatPanelBody,
  ChatPanelFooter,
  ChatPanelHeader,
} from './chat-panel.tsx';
import { ToolInvocationBlock } from './chat/tool-invocation-block.tsx';

// ── Cross-boundary shim for the still-`.jsx` shadcn Button primitive ──

type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost'
  | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};

const Button = ButtonModule.Button as React.ComponentType<ButtonProps>;

// ── Public types ─────────────────────────────────────────────────────

export interface ChatThreadProps
  extends Omit<UseChatStreamOptions, 'slug'> {
  /** Slug of the agent this thread targets. */
  slug: string;
  /** Optional title rendered in the header. Defaults to the slug. */
  title?: string;
  /** className merged onto the panel body's wrapping `<div>`. */
  className?: string;
  /**
   * Sub-AC 4 of AC 7: external budget-exhausted signal (e.g. derived
   * from the agent roster's `status === 'budget-exhausted' | 'paused'`
   * field) so the composer is disabled and the banner renders even
   * before the user attempts a send. The hook's own `budgetExhausted`
   * state still applies — the two signals are OR-ed so a server-side
   * verdict that arrives mid-conversation also gates the composer
   * regardless of what the consumer passed in.
   *
   * Pass `true` to mark the agent exhausted using the canonical
   * "Weekly budget exhausted — resume via aweek manage" copy. Pass an
   * object to override the banner copy / detail with the verdict
   * payload from the server (the same shape the hook surfaces).
   */
  budgetExhausted?: boolean | BudgetExhaustedInfo | null;
}

// ── Public component ────────────────────────────────────────────────

/**
 * Chat thread surface. See the module header for the full contract.
 */
export function ChatThread({
  slug,
  threadId,
  title,
  className,
  api,
  baseUrl,
  fetch: fetchImpl,
  initialMessages,
  onError,
  onMessagesChange,
  onTurnComplete,
  generateId,
  budgetExhausted: externalBudgetExhausted,
}: ChatThreadProps): React.ReactElement {
  // Forward only the keys that are actually defined so we don't
  // overwrite a hook default with `undefined`. (Object spread of an
  // explicit `undefined` value still trips `Object.hasOwn` checks in
  // some `useState` initializers.)
  const hookOpts: UseChatStreamOptions = { slug };
  if (threadId !== undefined) hookOpts.threadId = threadId;
  if (api !== undefined) hookOpts.api = api;
  if (baseUrl !== undefined) hookOpts.baseUrl = baseUrl;
  if (fetchImpl !== undefined) hookOpts.fetch = fetchImpl;
  if (initialMessages !== undefined) hookOpts.initialMessages = initialMessages;
  if (onError !== undefined) hookOpts.onError = onError;
  if (onMessagesChange !== undefined) hookOpts.onMessagesChange = onMessagesChange;
  if (onTurnComplete !== undefined) hookOpts.onTurnComplete = onTurnComplete;
  if (generateId !== undefined) hookOpts.generateId = generateId;

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    status,
    error,
    stop,
    budgetExhausted: streamBudgetExhausted,
  } = useChatStream(hookOpts);

  const isBusy = status === 'submitted' || status === 'streaming';
  const headerLabel = title ?? slug;

  // Sub-AC 4 of AC 7: resolve the effective budget verdict.
  //
  // Priority:
  //   1. The hook's own `budgetExhausted` (a server-side `budget-exhausted`
  //      SSE frame arriving mid-conversation always wins — the model
  //      response did NOT stream, the user's last attempt was rejected,
  //      and the verdict carries fresh `used` / `budget` numbers).
  //   2. The caller-supplied `externalBudgetExhausted` so the agent
  //      roster's `status === 'budget-exhausted' | 'paused'` flag
  //      gates the composer the moment the panel opens, before the
  //      user even attempts a send.
  //
  // A truthy `externalBudgetExhausted={true}` (the boolean shorthand)
  // surfaces the canonical "Weekly budget exhausted" copy without
  // numeric detail; a structured payload (matching the hook's shape)
  // surfaces the same detail string the server emits so the banner
  // can include "X of Y tokens" context.
  const resolvedBudgetExhausted: BudgetExhaustedInfo | true | null =
    streamBudgetExhausted ??
    (externalBudgetExhausted
      ? externalBudgetExhausted === true
        ? true
        : externalBudgetExhausted
      : null);

  const isBudgetExhausted = resolvedBudgetExhausted !== null;

  // Auto-scroll to the bottom on every render so streaming output
  // stays visible without user intervention. We pin the scroll to the
  // sentinel element so the effect doesn't fight a user who has
  // scrolled up on purpose — they can scroll up and the sentinel
  // simply sits below their viewport until they scroll back down.
  const bottomRef = React.useRef<HTMLLIElement | null>(null);
  React.useEffect(() => {
    // jsdom (and a handful of headless browsers) lack
    // `scrollIntoView` — guard so unit tests don't crash on every
    // streaming update. Real browsers always have the method.
    const node = bottomRef.current;
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'end' });
    }
  }, [messages]);

  // Focus the composer when ChatThread mounts. The parent re-keys this
  // component on `${slug}:${threadId}` so this fires every time the
  // user creates or switches threads — they can start typing without
  // having to click the textarea. The native `autoFocus` attribute is
  // unreliable here because the previous-thread's textarea may briefly
  // hold focus during the unmount/remount transition; an explicit
  // `.focus()` post-mount sidesteps that race.
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    const el = textareaRef.current;
    if (el && typeof el.focus === 'function' && !el.disabled) {
      el.focus();
    }
  }, []);

  return (
    <>
      <ChatPanelHeader>
        <div className="flex min-w-0 flex-col">
          <h2
            data-component="chat-thread-title"
            className="truncate text-sm font-semibold leading-tight"
          >
            {headerLabel}
          </h2>
          <ChatStatusLine status={status} error={error} />
        </div>
      </ChatPanelHeader>

      <ChatPanelBody className={cn('px-4 py-3', className)}>
        {messages.length === 0 ? (
          <ChatEmptyState />
        ) : (
          <ol
            data-component="chat-thread-messages"
            className="flex flex-1 flex-col gap-3"
          >
            {messages.map((m) => (
              <ChatMessageBubble key={m.id} message={m} status={status} />
            ))}
            <li ref={bottomRef} aria-hidden="true" />
          </ol>
        )}
      </ChatPanelBody>

      {isBudgetExhausted ? (
        <ChatBudgetBanner verdict={resolvedBudgetExhausted} />
      ) : null}

      <ChatPanelFooter>
        <form
          data-component="chat-thread-composer"
          onSubmit={handleSubmit}
          className="flex w-full items-end gap-2"
        >
          <textarea
            ref={textareaRef}
            data-component="chat-thread-input"
            aria-label={`Message ${headerLabel}`}
            placeholder={
              isBudgetExhausted
                ? 'Weekly budget exhausted — resume via aweek manage'
                : `Message ${headerLabel}…`
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={(event) => {
              // Enter to send (Shift+Enter for newline), matching
              // Slack / Discord / Linear chat ergonomics.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (isBudgetExhausted) return;
                handleSubmit();
              }
            }}
            // Sub-AC 4 of AC 7: lock the composer when the agent's
            // weekly budget is spent. The native `disabled` attribute
            // is the canonical signal screen readers + tests can pin
            // on; the placeholder copy + visual banner provide the
            // human-readable explanation.
            disabled={
              isBudgetExhausted || (isBusy && status === 'submitted')
            }
            rows={1}
            className={cn(
              'flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
              'placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          />
          {isBusy ? (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              data-component="chat-thread-stop"
              aria-label="Stop streaming"
              title="Stop streaming"
              onClick={() => stop()}
            >
              <Square aria-hidden="true" />
              <span className="sr-only">Stop streaming</span>
            </Button>
          ) : (
            <Button
              type="submit"
              variant="default"
              size="icon"
              data-component="chat-thread-send"
              aria-label="Send message"
              title="Send"
              disabled={isBudgetExhausted || input.trim().length === 0}
            >
              <Send aria-hidden="true" />
              <span className="sr-only">Send message</span>
            </Button>
          )}
        </form>
      </ChatPanelFooter>
    </>
  );
}

export default ChatThread;

// ── Subcomponents ────────────────────────────────────────────────────

interface ChatMessageBubbleProps {
  message: ChatUIMessage;
  status: ChatStatus;
}

function ChatMessageBubble({
  message,
  status,
}: ChatMessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';

  // Sub-AC 3 of AC 3: prefer the structured parts stream when the
  // assistant message has any. Each `tool-use` / `tool-result` SSE
  // pair populates a tool-invocation part keyed by `toolUseId`, and
  // text-deltas accumulate into the trailing text part. The renderer
  // walks the parts in arrival order so tool calls render inline
  // between the prose runs that surround them, matching the Claude
  // Code CLI's tool-use transparency.
  //
  // User messages and replayed initial messages typically omit `parts`,
  // so the legacy `content` fallback handles them.
  const parts = message.parts ?? [];
  const hasParts = !isUser && parts.length > 0;

  const isStreamingPlaceholder =
    !isUser &&
    !hasParts &&
    message.content.length === 0 &&
    (status === 'streaming' || status === 'submitted');

  return (
    <li
      data-component="chat-thread-message"
      data-role={message.role}
      className={cn(
        'flex flex-col gap-2',
        isUser ? 'items-end' : 'items-stretch',
      )}
    >
      {isStreamingPlaceholder ? (
        <div
          className={cn(
            'self-start max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm',
            'bg-muted text-foreground',
          )}
        >
          <span
            data-component="chat-thread-typing"
            className="inline-flex items-center gap-1 text-muted-foreground"
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            <span className="sr-only">Assistant is typing</span>
          </span>
        </div>
      ) : hasParts ? (
        parts.map((part, index) => (
          <ChatMessagePartRenderer
            // Tool-invocation parts get a stable key from `toolUseId`
            // so React reuses the component instance across renders
            // (preserving the user's expand/collapse state through
            // streaming updates). Text parts fall back to index since
            // their order is stable within a single message.
            key={
              part.type === 'tool-invocation'
                ? `tool-${part.toolUseId}`
                : `text-${index}`
            }
            part={part}
          />
        ))
      ) : isUser ? (
        <div
          className={cn(
            'max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm',
            'self-end bg-primary text-primary-foreground',
          )}
        >
          {message.content}
        </div>
      ) : (
        <div
          data-markdown="true"
          className={cn(
            'max-w-[85%] break-words rounded-lg px-3 py-2 text-sm',
            'self-start bg-muted text-foreground',
          )}
        >
          <Markdown source={message.content} />
        </div>
      )}
    </li>
  );
}

interface ChatMessagePartRendererProps {
  part: ChatUIMessagePart;
}

/**
 * Render a single {@link ChatUIMessagePart}. Text parts render as the
 * familiar muted-tinted assistant bubble; tool-invocation parts render
 * the {@link ToolInvocationBlock} collapsible inline so the user can
 * see the tool name + arg summary without expanding it.
 *
 * Sub-AC 3 of AC 3: this is the bridge between the structured parts
 * stream from `useChatStream` and the visual primitive shipped in
 * Sub-AC 1. Matching by `toolUseId` lives in the hook (`applyFrame` →
 * `applyToolResult`), so by the time a part lands here it already
 * carries the resolved `state` / `result` / `errorMessage`.
 */
function ChatMessagePartRenderer({
  part,
}: ChatMessagePartRendererProps): React.ReactElement | null {
  if (part.type === 'text') {
    if (part.text.length === 0) return null;
    return (
      <div
        data-component="chat-thread-message-text"
        data-markdown="true"
        className={cn(
          'self-start max-w-[85%] break-words rounded-lg px-3 py-2 text-sm',
          'bg-muted text-foreground',
        )}
      >
        <Markdown source={part.text} />
      </div>
    );
  }

  // Tool-invocation: surface the collapsible block in the same column
  // as the assistant prose, slightly narrower than the bubble width
  // so long arg payloads don't blow out the panel chrome.
  const toolInvocationProps: React.ComponentProps<typeof ToolInvocationBlock> =
    {
      name: part.toolName,
      args: part.args,
      state: part.state,
      'data-tool-use-id': part.toolUseId,
      className: 'self-start w-full max-w-[95%]',
    } as React.ComponentProps<typeof ToolInvocationBlock>;
  if (part.result !== undefined) toolInvocationProps.result = part.result;
  if (part.errorMessage !== undefined) {
    toolInvocationProps.errorMessage = part.errorMessage;
  }
  return <ToolInvocationBlock {...toolInvocationProps} />;
}

interface ChatStatusLineProps {
  status: ChatStatus;
  error: Error | null;
}

function ChatStatusLine({
  status,
  error,
}: ChatStatusLineProps): React.ReactElement | null {
  if (status === 'submitted') {
    return (
      <p
        data-component="chat-thread-status"
        data-status="submitted"
        className="text-xs text-muted-foreground"
      >
        Connecting…
      </p>
    );
  }
  if (status === 'streaming') {
    return (
      <p
        data-component="chat-thread-status"
        data-status="streaming"
        className="text-xs text-muted-foreground"
      >
        Streaming…
      </p>
    );
  }
  if (status === 'error') {
    return (
      <p
        data-component="chat-thread-status"
        data-status="error"
        className="text-xs text-destructive"
      >
        {error?.message ?? 'Something went wrong.'}
      </p>
    );
  }
  return null;
}

// ── Budget banner ────────────────────────────────────────────────────

interface ChatBudgetBannerProps {
  /**
   * Either `true` (the boolean shorthand from the agent roster — no
   * server-side detail available) or a structured verdict from the
   * hook / server. The banner copy adapts: the canonical
   * "Weekly budget exhausted — resume via aweek manage" string is
   * always present; the structured payload appends per-week numeric
   * detail when available.
   */
  verdict: BudgetExhaustedInfo | true;
}

/**
 * Inline banner rendered between the message list and the composer
 * when the agent's weekly budget is exhausted. Pairs with the
 * disabled composer (Sub-AC 4 of AC 7) so the user always sees both
 * the visual block and the locked-input affordance simultaneously.
 *
 * Copy contract — the test in `chat-thread.test.tsx` pins the exact
 * "Weekly budget exhausted — resume via aweek manage" string so
 * downstream marketing / docs can rely on a stable handle.
 */
function ChatBudgetBanner({
  verdict,
}: ChatBudgetBannerProps): React.ReactElement {
  const detail = verdict === true ? null : verdict.message;

  return (
    <div
      data-component="chat-thread-budget-banner"
      role="status"
      aria-live="polite"
      className={cn(
        'flex shrink-0 items-start gap-2 border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive',
      )}
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium leading-snug">
          Weekly budget exhausted — resume via aweek manage
        </p>
        {detail ? (
          <p
            data-component="chat-thread-budget-banner-detail"
            className="text-muted-foreground"
          >
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ChatEmptyState(): React.ReactElement {
  return (
    <div
      data-component="chat-thread-empty"
      className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center text-sm text-muted-foreground"
    >
      <p>Send a message to start the conversation.</p>
      <p className="text-xs italic">
        The agent will stream replies as they arrive.
      </p>
    </div>
  );
}
