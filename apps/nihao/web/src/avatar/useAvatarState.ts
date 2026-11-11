import { useLayoutEffect, useRef, useState } from 'react';
import { advanceAvatar, createController, expireAction, type AvatarFacts, type AvatarView } from './controller.ts';

/** No audio-frame state updates. Stable event IDs outlive Canvas remounts. */
export function useAvatarState(facts: AvatarFacts): AvatarView {
  const controller = useRef(createController(facts.epoch));
  const latest = useRef(facts);
  latest.current = facts;
  const [view, setView] = useState(controller.current.view);
  function update() {
    controller.current = advanceAvatar(controller.current, latest.current, performance.now());
    const next = controller.current.view;
    setView(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }
  const { chat, speech, dictation } = facts;
  useLayoutEffect(update, [facts.epoch, facts.welcome, chat?.id, chat?.status, chat?.hasText, chat?.toolRunning, chat?.hasArtifacts, speech.status, speech.messageId, speech.sessionId, dictation.status, dictation.errorCode]);
  useLayoutEffect(() => {
    const action = view.action;
    if (!action) return;
    const timer = setTimeout(() => {
      controller.current = expireAction(controller.current, action.id, action.epoch);
      update();
    }, Math.max(0, action.startedAt + action.duration - performance.now()));
    return () => clearTimeout(timer);
  }, [view.action]);
  return view;
}
