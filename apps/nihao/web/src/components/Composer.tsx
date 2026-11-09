import { ArrowUp, Check, ImagePlus, ImageOff, Mic, Square, X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { copy, dictationErrorMessage, errorMessage, type Locale } from '../copy.ts';
import type { DraftImage } from '../useImages.ts';
import type { DictationState } from '../useDictation.ts';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  pending: boolean;
  conversation: boolean;
  locale: Locale;
  images: DraftImage[];
  imageError?: string;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  dictation: DictationState;
  onStartDictation: () => void;
  onFinishDictation: () => void;
  onCancelDictation: () => void;
}

/** A shared composer preserves keyboard and cancellation behavior in both views. */
export function Composer({ value, onChange, onSend, onStop, pending, conversation, locale, images, imageError, onAddImages, onRemoveImage, dictation, onStartDictation, onFinishDictation, onCancelDictation }: ComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const text = copy[locale];
  const preparing = images.some((image) => image.status === 'processing');
  const failed = images.some((image) => image.status === 'error');
  const recording = dictation.status !== 'idle';
  const canSend = !recording && !pending && !preparing && !failed && (Boolean(value.trim()) || images.length > 0);
  const issue = imageError ?? images.find((image) => image.status === 'error')?.code;
  const dictationLabel = dictation.status === 'permission' ? text.voicePermission : dictation.status === 'connecting' ? text.voiceConnecting : dictation.status === 'finishing' ? text.voiceFinishing : text.voiceListening;
  const elapsed = `${Math.floor(dictation.seconds / 60)}:${String(Math.floor(dictation.seconds % 60)).padStart(2, '0')}`;

  useLayoutEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <form className={`composer${conversation ? ' composer--conversation' : ''}${recording ? ' composer--dictating' : ''}`} onSubmit={(event) => { event.preventDefault(); if (canSend) onSend(); }} onKeyDown={(event) => {
      if (recording && event.key === 'Escape') { event.preventDefault(); onCancelDictation(); }
    }}>
      {images.length > 0 && <div className="draft-images">
        {images.map((image) => <div key={image.id} className={`draft-image draft-image--${image.status}`}>
          {image.status === 'ready' ? <img src={image.image.dataUrl} alt={image.name} /> : <div className="draft-image-placeholder">
            {image.status === 'error' && <ImageOff size={18} strokeWidth={1.5} />}
            <span>{image.status === 'processing' ? text.preparingImage : text.imageFailed}</span>
          </div>}
          <button type="button" className="remove-image" aria-label={text.removeImage.replace('{name}', image.name)} title={text.removeImage.replace('{name}', image.name)} onClick={() => onRemoveImage(image.id)}><X size={14} strokeWidth={1.5} /></button>
        </div>)}
      </div>}
      <textarea
        ref={textarea}
        id="message-input"
        aria-label={text.inputLabel}
        placeholder={conversation ? text.followUpPlaceholder : text.placeholder}
        value={value}
        readOnly={recording}
        rows={conversation ? 1 : 2}
        maxLength={12000}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          if (recording) { event.preventDefault(); return; }
          const files = Array.from(event.clipboardData.files);
          if (files.length) { event.preventDefault(); onAddImages(files); }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (dictation.status === 'recording') onFinishDictation();
            else if (canSend) onSend();
          }
        }}
      />
      {issue && <p className="attachment-error" role="alert">{errorMessage(issue, locale)}</p>}
      {dictation.errorCode && <p className="dictation-error" role="alert">{dictationErrorMessage(dictation.errorCode, locale)}</p>}
      <div className="composer-toolbar">
        {recording ? <div className="dictation-controls">
          <button type="button" className="dictation-cancel" aria-label={text.cancelVoiceInput} title={text.cancelVoiceInput} onClick={onCancelDictation}><X size={18} strokeWidth={1.5} /></button>
          <div className="dictation-progress">
            <span className="dictation-status" role="status">{dictationLabel}</span>
            <div className="dictation-waveform" aria-hidden="true">
              {dictation.levels.map((level, index) => <span key={index} style={{ transform: `scaleY(${Math.max(.08, Math.min(1, Math.sqrt(level) * 3))})` }} />)}
            </div>
            <span className="dictation-timer" aria-hidden="true">{elapsed}</span>
          </div>
          <button type="button" className="send-button dictation-finish" aria-label={text.finishVoiceInput} title={text.finishVoiceInput} disabled={dictation.status !== 'recording'} onClick={onFinishDictation}><Check size={22} strokeWidth={1.8} /></button>
        </div> : <>
        <div className="composer-tools">
          <input ref={fileInput} type="file" id="image-input" className="sr-only" accept="image/jpeg,image/png,image/webp" multiple tabIndex={-1} aria-label={text.chooseImages} onChange={(event) => {
            onAddImages(Array.from(event.target.files ?? []));
            event.target.value = '';
          }} />
          <button type="button" className="attach-button" aria-label={text.attachImages} title={text.imageFormats} onClick={() => fileInput.current?.click()}><ImagePlus size={18} strokeWidth={1.5} /></button>
          <span className="composer-hint" aria-live="polite">{preparing ? text.preparingImages : failed ? text.imageNeedsRemoval : conversation ? text.keyboardHint : text.composerHint}</span>
        </div>
        <div className="composer-send-tools">
        <button type="button" className="microphone-button" aria-label={text.startVoiceInput} title={text.voiceInputHint} disabled={pending} onClick={onStartDictation}><Mic size={20} strokeWidth={1.5} /></button>
        {pending ? (
          <button type="button" className="send-button" aria-label={text.stop} title={text.stop} onClick={onStop}>
            <Square size={18} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button type="submit" className="send-button" aria-label={text.send} title={text.send} disabled={!canSend}>
            <ArrowUp size={24} strokeWidth={1.8} />
          </button>
        )}
        </div>
        </>}
      </div>
    </form>
  );
}
