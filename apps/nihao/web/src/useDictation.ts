import { useEffect, useRef, useState } from 'react';
import { appendDictation, DictationCapture, type DictationStatus } from './dictation.ts';

export interface DictationState {
  status: DictationStatus;
  seconds: number;
  levels: number[];
  errorCode?: string;
}

const emptyState = (): DictationState => ({ status: 'idle', seconds: 0, levels: Array(24).fill(0) as number[] });

/** A capture can modify only its own draft suffix; cancellation restores its snapshot. */
export function useDictation(onChange: (draft: string) => void, beforeStart: () => void) {
  const [state, setState] = useState<DictationState>(emptyState);
  const active = useRef<{ capture: DictationCapture; original: string } | undefined>(undefined);
  const callbacks = useRef({ onChange, beforeStart });
  callbacks.current = { onChange, beforeStart };

  function cancel(restore = true): void {
    const session = active.current;
    active.current = undefined;
    session?.capture.cancel();
    if (restore && session) callbacks.current.onChange(session.original);
    setState(emptyState());
  }

  useEffect(() => {
    const leave = (): void => cancel();
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !active.current || event.isComposing) return;
      event.preventDefault();
      cancel();
      document.getElementById('message-input')?.focus();
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('keydown', escape);
      const session = active.current;
      active.current = undefined;
      session?.capture.cancel();
    };
  }, []);

  function start(original: string): void {
    if (active.current) return;
    callbacks.current.beforeStart();
    setState({ ...emptyState(), status: 'permission' });
    const focus = (): void => { requestAnimationFrame(() => document.getElementById('message-input')?.focus()); };
    const capture = new DictationCapture({
      onStatus: status => { if (active.current?.capture === capture) setState(current => ({ ...current, status })); },
      onMeter: (level, seconds) => {
        if (active.current?.capture === capture) setState(current => ({ ...current, seconds, levels: [...current.levels.slice(1), level] }));
      },
      onTranscript: transcript => {
        if (active.current?.capture !== capture) return;
        const combined = appendDictation(original, transcript);
        callbacks.current.onChange(combined.slice(0, 12000));
        if (combined.length > 12000) capture.fail('ASR_TEXT_TOO_LONG');
      },
      onComplete: () => {
        if (active.current?.capture !== capture) return;
        active.current = undefined;
        setState(emptyState());
        focus();
      },
      onError: errorCode => {
        if (active.current?.capture !== capture) return;
        active.current = undefined;
        setState({ ...emptyState(), errorCode });
        focus();
      },
    });
    active.current = { capture, original };
    capture.start();
    focus();
  }

  return { state, isActive: state.status !== 'idle', start, finish: () => active.current?.capture.finish(), cancel };
}
