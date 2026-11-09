import { useEffect, useRef, useState } from 'react';
import { SpeechError, StreamingPcmPlayer, streamSpeech } from './speech.ts';

export interface SpeechState {
  messageId?: string;
  status: 'idle' | 'loading' | 'playing' | 'complete' | 'error';
  errorCode?: string;
}

interface Playback {
  controller: AbortController;
  context: AudioContext;
  player: StreamingPcmPlayer;
}

interface CachedSpeech { messageId: string; text: string; chunks: Uint8Array[] }
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** One owner for audio across every reply; no persistent audio storage. */
export function useSpeech() {
  const [state, setState] = useState<SpeechState>({ status: 'idle' });
  const [replayId, setReplayId] = useState<string>();
  const active = useRef<Playback | undefined>(undefined);
  const cache = useRef<CachedSpeech | undefined>(undefined);

  function cancelActive(): void {
    const playback = active.current;
    active.current = undefined;
    if (!playback) return;
    playback.controller.abort();
    playback.player.stop();
    void playback.context.close().catch(() => undefined);
  }

  useEffect(() => () => {
    cancelActive();
    cache.current = undefined;
  }, []);

  function stop(): void {
    cancelActive();
    setState({ status: 'idle' });
  }

  function reset(): void {
    stop();
    cache.current = undefined;
    setReplayId(undefined);
  }

  function play(messageId: string, text: string): void {
    cancelActive();
    setState({ messageId, status: 'loading' });
    let context: AudioContext;
    let resume: Promise<void>;
    try {
      const BrowserAudioContext = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!BrowserAudioContext) throw new SpeechError('SPEECH_UNSUPPORTED');
      // Both operations happen in the click handler, before the first await.
      context = new BrowserAudioContext();
      resume = context.resume();
    } catch {
      setState({ messageId, status: 'error', errorCode: 'SPEECH_UNSUPPORTED' });
      return;
    }
    const playback: Playback = { context, controller: new AbortController(), player: new StreamingPcmPlayer(context) };
    active.current = playback;

    void (async () => {
      let resumeTimer: ReturnType<typeof setTimeout> | undefined;
      let nextCache: CachedSpeech | undefined;
      try {
        await Promise.race([
          resume,
          new Promise<never>((_, reject) => { resumeTimer = setTimeout(() => reject(new SpeechError('SPEECH_PLAYBACK_BLOCKED')), 5000); }),
        ]);
        clearTimeout(resumeTimer);
        if (active.current !== playback) return;
        if (context.state !== 'running') throw new SpeechError('SPEECH_PLAYBACK_BLOCKED');
        const cached = cache.current;
        if (cached?.messageId === messageId && cached.text === text) {
          for (const bytes of cached.chunks) playback.player.enqueue(bytes);
          setState({ messageId, status: 'playing' });
        } else {
          let cachedBytes = 0;
          let chunks: Uint8Array[] | undefined = [];
          await streamSpeech(text, playback.controller.signal, bytes => {
            if (active.current !== playback) return;
            if (playback.player.enqueue(bytes)) setState(current => current.status === 'playing' ? current : { messageId, status: 'playing' });
            cachedBytes += bytes.length;
            if (cachedBytes <= MAX_CACHE_BYTES) chunks?.push(bytes);
            else chunks = undefined;
          });
          if (active.current !== playback) return;
          if (chunks) nextCache = { messageId, text, chunks };
        }
        await playback.player.finish();
        if (active.current === playback) {
          if (nextCache) {
            cache.current = nextCache;
            setReplayId(messageId);
          }
          setState({ messageId, status: 'complete' });
        }
      } catch (error) {
        if (active.current === playback && !playback.controller.signal.aborted) {
          setState({ messageId, status: 'error', errorCode: error instanceof SpeechError ? error.code : 'SPEECH_UNAVAILABLE' });
        }
      } finally {
        clearTimeout(resumeTimer);
        playback.player.stop();
        void context.close().catch(() => undefined);
        if (active.current === playback) active.current = undefined;
      }
    })();
  }

  return { state, replayId, play, stop, reset };
}
