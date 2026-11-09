import { ArrowDown, ArrowUpRight, Compass, Languages, Utensils } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChatError, streamChat, type ChatMessage } from './chat.ts';
import { copy, type Locale } from './copy.ts';
import { Composer } from './components/Composer.tsx';
import { Header } from './components/Header.tsx';
import { Message, type DisplayMessage } from './components/Message.tsx';
import { useImages } from './useImages.ts';
import { ImagePreparationError, validateConversationImages } from './images.ts';
import { useSpeech } from './useSpeech.ts';
import { useDictation } from './useDictation.ts';
import type { TravelArtifact } from '../../shared/travel.ts';
import { mergeTravelArtifact } from './travel.ts';

/** Include only completed exchanges, so failed or cancelled output is never context. */
function completedTranscript(messages: DisplayMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let user: ChatMessage | undefined;
  for (const message of messages) {
    if (message.role === 'user') user = { role: 'user', content: message.content, ...(message.images?.length ? { images: message.images } : {}) };
    else if (user && message.status === 'complete' && message.content.trim()) {
      result.push(user, { role: 'assistant', content: message.content });
      user = undefined;
    }
  }
  return result;
}

/** Nihao's single conversation, with text, user images, and scoped request ownership. */
export function App() {
  const [locale, setLocale] = useState<Locale>('en');
  const [draft, setDraft] = useState('');
  const attachments = useImages();
  const speech = useSpeech();
  const dictation = useDictation(setDraft, speech.stop);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const active = useRef<{ controller: AbortController; id: string } | undefined>(undefined);
  const travelSession = useRef<string | undefined>(undefined);
  const conversation = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const text = copy[locale];
  const hasConversation = messages.length > 0;

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = `${text.brand} — ${text.heading}`;
  }, [locale, text]);

  useEffect(() => () => { active.current?.controller.abort(); }, []);

  useEffect(() => {
    if (hasConversation) document.getElementById('message-input')?.focus();
  }, [hasConversation]);

  useLayoutEffect(() => {
    if (follow.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [messages]);

  async function run(history: ChatMessage[], nextMessages: DisplayMessage[]) {
    if (active.current) return;
    dictation.cancel();
    speech.stop();
    const id = crypto.randomUUID();
    const controller = new AbortController();
    active.current = { controller, id };
    follow.current = true;
    setAwayFromBottom(false);
    setPending(true);
    setMessages([...nextMessages, { id, role: 'assistant', content: '', status: 'streaming', responseLanguage: locale }]);
    let artifacts: TravelArtifact[] = [];

    try {
      await streamChat(history, locale, controller.signal, (chunk) => {
        if (active.current?.id !== id) return;
        setMessages((current) => current.map((message) => message.id === id ? { ...message, content: message.content + chunk } : message));
      }, {
        travelSession: travelSession.current,
        onTravelEvent(event) {
          if (active.current?.id !== id) return;
          if (event.type === 'travel-session') travelSession.current = event.id;
          else if (event.type === 'artifact') artifacts = mergeTravelArtifact(artifacts, event.artifact);
          else if (event.type === 'response-language') setMessages(current => current.map(message => message.id === id ? { ...message, responseLanguage: event.language } : message));
          else setMessages(current => current.map(message => message.id === id ? { ...message, toolStatus: event } : message));
        },
      });
      if (active.current?.id === id) {
        setMessages((current) => current.map((message) => message.id === id ? { ...message, status: 'complete', travel: artifacts, toolStatus: undefined } : message));
      }
    } catch (error) {
      if (active.current?.id !== id) return;
      const status = controller.signal.aborted ? 'stopped' : 'error';
      const errorCode = error instanceof ChatError ? error.code : 'NETWORK_ERROR';
      if (errorCode === 'TRAVEL_SESSION_EXPIRED') travelSession.current = undefined;
      setMessages((current) => current.map((message) => message.id === id ? { ...message, status, errorCode, toolStatus: undefined } : message));
    } finally {
      if (active.current?.id === id) {
        active.current = undefined;
        setPending(false);
      }
    }
  }

  function send() {
    const content = draft.trim();
    const images = attachments.readyImages();
    if (!images || (!content && !images.length) || active.current || dictation.isActive) return;
    const userMessage: ChatMessage = { role: 'user', content, ...(images.length ? { images } : {}) };
    const history = [...completedTranscript(messages), userMessage];
    try { validateConversationImages(history.flatMap((message) => message.images ?? [])); }
    catch (error) {
      attachments.setErrorCode(error instanceof ImagePreparationError ? error.code : 'INVALID_IMAGE');
      return;
    }
    const user: DisplayMessage = { ...userMessage, id: crypto.randomUUID(), status: 'complete' };
    setDraft('');
    attachments.clearImages();
    void run(history, [...messages, user]);
  }

  function stop() {
    const request = active.current;
    if (!request) return;
    request.controller.abort();
    active.current = undefined;
    setPending(false);
    setMessages((current) => current.map((message) => message.id === request.id ? { ...message, status: 'stopped', toolStatus: undefined } : message));
  }

  function retry() {
    if (active.current) return;
    const previous = messages.slice(0, -1);
    const lastUser = previous[previous.length - 1];
    if (!lastUser || lastUser.role !== 'user') return;
    void run([...completedTranscript(previous), { role: 'user', content: lastUser.content, ...(lastUser.images?.length ? { images: lastUser.images } : {}) }], previous);
  }

  function newChat() {
    dictation.cancel(false);
    speech.reset();
    active.current?.controller.abort();
    active.current = undefined;
    travelSession.current = undefined;
    setPending(false);
    setMessages([]);
    setDraft('');
    attachments.clearImages();
    setAwayFromBottom(false);
    follow.current = true;
    requestAnimationFrame(() => document.getElementById('message-input')?.focus());
  }

  function jumpToBottom() {
    follow.current = true;
    setAwayFromBottom(false);
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' });
  }

  const composer = {
    value: draft,
    onChange: setDraft,
    onSend: send,
    onStop: stop,
    pending,
    conversation: hasConversation,
    locale,
    images: attachments.images,
    imageError: attachments.errorCode,
    onAddImages: attachments.addImages,
    onRemoveImage: attachments.removeImage,
    dictation: dictation.state,
    onStartDictation: () => { if (!pending) dictation.start(draft); },
    onFinishDictation: dictation.finish,
    onCancelDictation: () => {
      dictation.cancel();
      requestAnimationFrame(() => document.getElementById('message-input')?.focus());
    },
  };

  return (
    <div className={`app${hasConversation ? ' app--conversation' : ''}`}>
      <div className="ambient-grid" aria-hidden="true" />
      <Header locale={locale} onLocale={setLocale} conversation={hasConversation} onNewChat={newChat} />
      {hasConversation ? (
        <main className="chat-view">
          <h1 className="sr-only">{text.brand}</h1>
          <div
            className="conversation-scroll"
            ref={conversation}
            onScroll={() => {
              const element = conversation.current;
              if (!element) return;
              const away = element.scrollHeight - element.scrollTop - element.clientHeight > 96;
              follow.current = !away;
              setAwayFromBottom(away);
            }}
          >
            <div className="conversation" role="log" aria-live="off" aria-label={text.brand}>
              {messages.map((message, index) => <Message key={message.id} message={message} locale={locale} canRetry={!pending && index === messages.length - 1} onRetry={retry} speechState={speech.state.messageId === message.id ? speech.state : undefined} canReplay={speech.replayId === message.id} onSpeak={() => { dictation.cancel(); speech.play(message.id, message.content); }} onStopSpeech={speech.stop} />)}
            </div>
          </div>
          <div className="chat-composer-wrap">
            {awayFromBottom && <button type="button" className="jump-button" aria-label={text.scrollToBottom} title={text.scrollToBottom} onClick={jumpToBottom}><ArrowDown size={18} strokeWidth={1.5} /></button>}
            <Composer {...composer} />
            <p className="disclaimer">{text.disclaimer}</p>
          </div>
        </main>
      ) : (
        <main className="welcome-view">
          <section className="welcome-content" aria-labelledby="welcome-heading">
            <div className="welcome-intro">
              <p className="welcome-tagline">{text.tagline}</p>
              <p className="welcome-description">{text.description}</p>
            </div>
            <h1 id="welcome-heading">{text.heading}</h1>
            <Composer {...composer} />
            <div className="prompt-starters">
              {text.prompts.map((prompt, index) => {
                const Icon = [Compass, Utensils, Languages][index] ?? Compass;
                return <button type="button" key={prompt} disabled={dictation.isActive} onClick={() => { setDraft(prompt); document.getElementById('message-input')?.focus(); }}>
                  <Icon size={18} strokeWidth={1.5} />
                  <span>{text.promptLabels[index]}</span>
                  <ArrowUpRight className="prompt-arrow" size={16} strokeWidth={1.5} />
                </button>;
              })}
            </div>
          </section>
          <p className="welcome-footer">{text.disclaimer}</p>
        </main>
      )}
      <span className="sr-only" role="status">{pending ? text.writing : ''}</span>
    </div>
  );
}
