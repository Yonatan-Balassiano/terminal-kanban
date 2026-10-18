import { memo, useEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rpc } from './api';
import type { GetConversationResult } from '../../src/types/index.js';

const POLL_MS = 3_000;

// react-markdown never renders raw HTML from the text, so a transcript cannot inject markup.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/**
 * Markdown, rendered for the dark terminal panels (conversation, description).
 * Memoised: the poll re-renders every 3s, and re-parsing unchanged text is wasted work.
 */
export const MarkdownText = memo(function MarkdownText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`.trim()}>
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
});

const UNAVAILABLE: Record<NonNullable<GetConversationResult['unavailable']>, string> = {
  'no-session': 'No conversation yet. Press Enter to start the session.',
  'no-transcript': 'The conversation has not been written yet.',
  remote: 'This card runs on a remote host; its conversation is kept there.',
};

/**
 * The last turns of the card's conversation, refreshed while the card is
 * selected and the page is visible. Polling, not a push: the daemon learns
 * about a transcript only by reading it, and this is one small read.
 */
export function Conversation({ taskId }: { taskId: string }) {
  const [data, setData] = useState<GetConversationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const reload = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    stickToBottom.current = true;
    let inFlight = false;
    const load = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const result = await rpc<GetConversationResult>('getConversation', { taskId, limit: 40 });
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    };
    reload.current = load;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  // Follow new messages, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  return (
    <section>
      <h2>
        Conversation
        {data?.updatedAt ? <span className="h2-note">updated {new Date(data.updatedAt).toLocaleTimeString()}</span> : null}
      </h2>
      {error && <p className="error small">{error}</p>}
      {!data && !error && <p className="muted small">Loading…</p>}
      {data?.unavailable && <p className="muted small">{UNAVAILABLE[data.unavailable]}</p>}
      {data && !data.unavailable && data.messages.length === 0 && (
        <p className="muted small">Nothing readable in the latest part of the conversation.</p>
      )}
      {data && data.messages.length > 0 && (
        <div
          className="convo"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {data.messages.map((message, index) =>
            message.role === 'tool' ? (
              <div key={index} className="msg msg-tool" title={message.text}>
                <span className="msg-mark">⎿</span>
                <span className="msg-tool-text">{message.text}</span>
              </div>
            ) : (
              <div key={index} className={`msg msg-${message.role}`}>
                <span className="msg-mark" aria-label={message.role === 'user' ? 'You' : 'Claude'}>
                  {message.role === 'user' ? '>' : '●'}
                </span>
                <MarkdownText className="msg-text" text={message.text} />
              </div>
            ),
          )}
        </div>
      )}
      <Composer
        taskId={taskId}
        onSent={() => {
          stickToBottom.current = true;
          // The agent writes the turn to its transcript a moment after it is submitted.
          window.setTimeout(() => void reload.current(), 800);
        }}
      />
    </section>
  );
}

interface NotifyOutcome {
  delivered: boolean;
  queued: boolean;
  landedUnsubmitted?: boolean;
}

type SendStatus = { kind: 'pending' | 'ok' | 'warn' | 'error'; text: string };

/**
 * Sends a message into the card's session through `notifyTaskSession` — the
 * same path as `agentboard task notify`: typed into the live pane and verified,
 * or queued for the session's next start when there is no live pane.
 */
function Composer({ taskId, onSent }: { taskId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<SendStatus | null>(null);
  const sending = status?.kind === 'pending';

  useEffect(() => {
    setText('');
    setStatus(null);
  }, [taskId]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setStatus({ kind: 'pending', text: 'Sending…' });
    try {
      const outcome = await rpc<NotifyOutcome>('notifyTaskSession', { taskId, message });
      if (outcome.delivered) {
        setText('');
        setStatus({ kind: 'ok', text: 'Sent' });
        onSent();
      } else if (outcome.queued) {
        setText('');
        setStatus({ kind: 'warn', text: 'No live session — queued. It is delivered when the session next starts.' });
      } else if (outcome.landedUnsubmitted) {
        setText('');
        setStatus({
          kind: 'warn',
          text: 'Typed into the session but not submitted. Open it in the terminal and press Enter, or restart it (R).',
        });
      } else {
        setStatus({ kind: 'error', text: 'Not delivered.' });
      }
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="composer-box">
        <span className="msg-mark" aria-hidden="true">
          &gt;
        </span>
        <textarea
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          value={text}
          placeholder="Message the session…  (Enter to send, Shift+Enter for a new line)"
          aria-label="Message the session"
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            } else if (event.key === 'Escape') {
              event.currentTarget.blur();
            }
          }}
        />
        <button type="submit" className="composer-send" disabled={!text.trim() || sending} title="Send (Enter)">
          {sending ? '…' : '↵'}
        </button>
      </div>
      {status && <p className={`composer-status composer-${status.kind}`}>{status.text}</p>}
    </form>
  );
}
