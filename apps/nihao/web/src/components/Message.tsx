import { Check, Copy, RotateCcw, Square, Volume2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../chat.ts';
import { copy, errorMessage, speechErrorMessage, type Locale } from '../copy.ts';
import { ImagePreview } from './ImagePreview.tsx';
import type { ChatImage } from '../chat.ts';
import type { SpeechState } from '../useSpeech.ts';
import type { TravelArtifact, TravelEvent } from '../../../shared/travel.ts';
import { TravelArtifacts } from './TravelArtifacts.tsx';
import { NihaoAvatar } from './NihaoAvatar.tsx';
import type { AvatarView } from '../avatar/controller.ts';
import { readableReplyText } from '../markdown.ts';

const MarkdownReply = lazy(() => import('./MarkdownReply.tsx'));

/** Local delivery state is never sent as model input. */
export interface DisplayMessage extends ChatMessage {
  id: string;
  status: 'complete' | 'streaming' | 'stopped' | 'error';
  errorCode?: string;
  /** Frozen per reply so interface language changes cannot mix translated map text and labels. */
  responseLanguage?: Locale;
  travel?: TravelArtifact[];
  toolStatus?: Extract<TravelEvent, { type: 'tool-status' }>;
}

interface MessageProps {
  message: DisplayMessage;
  locale: Locale;
  canRetry: boolean;
  onRetry: () => void;
  speechState?: SpeechState;
  canReplay: boolean;
  onSpeak: (text: string) => void;
  onStopSpeech: () => void;
  avatar?: AvatarView;
  readLevel?: () => number;
}

/** Assistant Markdown is rendered safely; user messages retain their literal text. */
export function Message({ message, locale, canRetry, onRetry, speechState, canReplay, onSpeak, onStopSpeech, avatar, readLevel }: MessageProps) {
  const text = copy[locale];
  const travelLocale = message.responseLanguage ?? locale;
  const travelText = copy[travelLocale];
  const mapError = message.errorCode?.startsWith('TRAVEL_') || message.errorCode?.startsWith('MAPS_') || message.errorCode === 'INVALID_TRAVEL_RESPONSE';
  const errorLocale = mapError ? travelLocale : locale;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [preview, setPreview] = useState<ChatImage | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const body = useRef<HTMLDivElement>(null);
  const speaking = speechState?.status === 'playing' || speechState?.status === 'loading';
  const speechLabel = speaking ? text.stopReading : canReplay ? text.replaySpeech : text.readAloud;
  const toolRunning = message.status === 'streaming' && message.toolStatus?.status === 'running';
  const toolLabel = message.toolStatus?.tool === 'translate' ? travelText.travelTranslating : message.toolStatus?.tool === 'route' ? travelText.travelFindingRoutes : message.toolStatus?.tool === 'plan' ? travelText.travelPlanning : message.toolStatus?.tool === 'details' ? travelText.travelCheckingPlace : travelText.travelFindingPlaces;
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copyResponse() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopyState('copied');
    } catch (error) {
      // Clipboard access can be refused by the browser; retain selectable text.
      setCopyState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('idle'), 2400);
  }

  return (
    <article className={`message message--${message.role}`} aria-label={message.role === 'user' ? text.user : text.brand}>
      {message.role === 'assistant' && <div className="assistant-name">
        <NihaoAvatar state={avatar} readLevel={readLevel} label={text.avatarLabel} />
        <span>{text.brand}</span>
      </div>}
      <div className="message-body" ref={body}>
        {message.images?.length ? <div className="message-images">
          {message.images.map((image, index) => <button type="button" key={`${message.id}-${index}`} className="message-image" aria-label={text.viewImage.replace('{name}', image.name)} onClick={() => setPreview(image)}>
            <img src={image.dataUrl} alt={image.name} />
          </button>)}
        </div> : null}
        {message.content ? message.role === 'assistant' ? <Suspense fallback={<p className="message-text">{message.content}</p>}><MarkdownReply content={message.content} locale={locale} /></Suspense> : <p className="message-text">{message.content}</p> : message.status === 'streaming' && !toolRunning ? <p className="thinking-text">{text.thinking}</p> : null}
        {toolRunning && <p className="travel-tool-status" role="status" lang={travelLocale === 'zh' ? 'zh-CN' : 'en'}><span aria-hidden="true" />{toolLabel}</p>}
        {message.status === 'complete' && message.travel?.length ? <TravelArtifacts artifacts={message.travel} locale={travelLocale} /> : null}
        {message.role === 'assistant' && message.status === 'error' && (
          <div className="reply-error" role="alert">
            <p>{errorMessage(message.errorCode ?? 'PROVIDER_ERROR', errorLocale)}</p>
            {canRetry && <button type="button" onClick={onRetry}>{copy[errorLocale].retry}</button>}
          </div>
        )}
        {message.status === 'stopped' && <div className="reply-stopped">
          <p className="reply-status">{text.stopped}</p>
          {canRetry && <button type="button" onClick={onRetry}>{text.retry}</button>}
        </div>}
        {message.role === 'assistant' && message.content && message.status !== 'streaming' && (
          <div className="message-actions">
            <button type="button" className="copy-button" onClick={() => void copyResponse()} aria-label={copyState === 'copied' ? text.copied : text.copy} title={text.copy}>
              {copyState === 'copied' ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
              <span>{copyState === 'copied' ? text.copied : text.copy}</span>
            </button>
            <button type="button" className={`speech-button${speaking ? ' speech-button--active' : ''}`} onClick={speaking ? onStopSpeech : () => onSpeak(readableReplyText(body.current?.querySelector('.message-text') ?? null, message.content))} aria-label={speechLabel} title={speechLabel}>
              {speaking ? <Square size={16} strokeWidth={1.5} /> : canReplay ? <RotateCcw size={16} strokeWidth={1.5} /> : <Volume2 size={16} strokeWidth={1.5} />}
              <span>{speechState?.status === 'loading' ? text.cancelPreparingSpeech : speechLabel}</span>
            </button>
            {copyState === 'failed' && <span className="copy-error" role="status">{text.copyFailed}</span>}
          </div>
        )}
        {message.role === 'assistant' && speechState?.status === 'error' && <p className="speech-error" role="alert">{speechErrorMessage(speechState.errorCode ?? 'SPEECH_UNAVAILABLE', locale)}</p>}
        {speaking && <span className="sr-only" role="status">{speechState?.status === 'loading' ? text.preparingSpeech : text.readingSpeech}</span>}
      </div>
      {preview && <ImagePreview image={preview} locale={locale} onClose={() => setPreview(undefined)} />}
    </article>
  );
}
