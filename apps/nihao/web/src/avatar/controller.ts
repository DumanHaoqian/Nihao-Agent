import type { DictationStatus } from '../dictation.ts';
import type { SpeechState } from '../useSpeech.ts';
import type { TravelArtifact } from '../../../shared/travel.ts';

export type Activity = 'idle' | 'waiting' | 'thinking' | 'listening' | 'speaking';
export type Expression = 'neutral' | 'thinking' | 'concerned';
export interface AvatarAction { id: string; epoch: number; kind: 'waving' | 'nodding'; startedAt: number; duration: number }
export interface AvatarView {
  epoch: number;
  target?: 'welcome' | 'message' | 'input';
  messageId?: string;
  activity: Activity;
  expression: Expression;
  action?: AvatarAction;
}
export interface AvatarFacts {
  epoch: number;
  welcome: boolean;
  chat?: { id: string; status: 'streaming' | 'complete' | 'stopped' | 'error'; hasText: boolean; toolRunning: boolean; hasArtifacts: boolean };
  speech: SpeechState;
  dictation: { status: DictationStatus; errorCode?: string };
}
export interface Controller { epoch: number; seen: ReadonlySet<string>; view: AvatarView }
export const STATIC_AVATAR: AvatarView = { epoch: -1, activity: 'idle', expression: 'neutral' };
export function createController(epoch: number): Controller { return { epoch, seen: new Set(), view: { ...STATIC_AVATAR, epoch } }; }

/** Empty search/route containers are not a displayed travel result. Input is already validated. */
export function hasTravelResult(artifacts?: TravelArtifact[]): boolean {
  return artifacts?.some(artifact => artifact.kind === 'places' ? artifact.places.length > 0 : artifact.kind === 'routes' ? artifact.routes.length > 0 : artifact.itinerary.days.some(day => day.stops.length > 0)) ?? false;
}

/** One owner. Events are consumed when seen, never queued behind higher-priority work. */
export function advanceAvatar(previous: Controller, facts: AvatarFacts, now: number): Controller {
  if (facts.epoch < previous.epoch) return previous;
  const state = facts.epoch === previous.epoch ? previous : createController(facts.epoch);
  const seen = new Set(state.seen);
  const { chat, speech, dictation, epoch } = facts;
  let candidate: AvatarView | undefined;
  function once(key: string, kind: AvatarAction['kind'], target: AvatarView['target'], messageId?: string) {
    if (seen.has(key)) return;
    seen.add(key);
    candidate = { epoch, activity: 'idle', expression: 'neutral', target, messageId, action: { id: key, epoch, kind, startedAt: now, duration: kind === 'waving' ? 1200 : 1080 } };
  }
  if (facts.welcome) once(`welcome:${epoch}`, 'waving', 'welcome');
  if (chat?.status === 'complete' && chat.hasArtifacts) once(`travel:${chat.id}`, 'nodding', 'message', chat.id);
  if (speech.status === 'complete' && speech.messageId && speech.sessionId) once(`speech:${speech.sessionId}`, 'nodding', 'message', speech.messageId);
  let view: AvatarView = { epoch, activity: 'idle', expression: 'neutral' };
  const speaking = speech.status === 'playing' && speech.messageId;
  if (speaking) view = { ...view, target: 'message', messageId: speech.messageId, activity: 'speaking' };
  else if (dictation.status !== 'idle') view = { ...view, target: facts.welcome ? 'welcome' : 'input', activity: dictation.status === 'recording' ? 'listening' : 'waiting' };
  else if (speech.status === 'loading' && speech.messageId) view = { ...view, target: 'message', messageId: speech.messageId, activity: 'waiting' };
  else if (chat?.status === 'streaming') {
    const thinking = !chat.hasText || chat.toolRunning;
    view = { ...view, target: 'message', messageId: chat.id, activity: thinking ? 'thinking' : 'idle', expression: thinking ? 'thinking' : 'neutral' };
  } else if (dictation.errorCode) view = { ...view, target: facts.welcome ? 'welcome' : 'input', expression: 'concerned' };
  else if (speech.status === 'error' && speech.messageId) view = { ...view, target: 'message', messageId: speech.messageId, expression: 'concerned' };
  else if (chat?.status === 'error') view = { ...view, target: 'message', messageId: chat.id, expression: 'concerned' };
  else if (candidate) view = candidate;
  else if (state.view.action && now < state.view.action.startedAt + state.view.action.duration && chat?.status !== 'stopped') view = state.view;
  else if (facts.welcome) view = { ...view, target: 'welcome' };
  return { epoch, seen, view };
}

export function expireAction(state: Controller, id: string, epoch: number): Controller {
  if (state.epoch !== epoch || state.view.action?.id !== id) return state;
  return { ...state, view: { ...state.view, action: undefined } };
}
export function avatarForMessage(view: AvatarView, messageId: string): AvatarView {
  return view.target === 'message' && view.messageId === messageId ? view : STATIC_AVATAR;
}
