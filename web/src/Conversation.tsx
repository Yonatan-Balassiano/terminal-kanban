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

/** Memoised: the poll re-renders every 3s, and re-parsing unchanged messages is wasted work. */
const MessageText = memo(function MessageText({ text }: { text: string }) {
  return (
    <div className="msg-text md">
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

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    stickToBottom.current = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const result = await rpc<GetConversationResult>('getConversation', { taskId, limit: 40 });
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
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
                <MessageText text={message.text} />
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}
