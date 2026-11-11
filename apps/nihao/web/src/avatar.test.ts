import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceAvatar, avatarForMessage, createController, expireAction, hasTravelResult, type AvatarFacts } from './avatar/controller.ts';
import { MouthEnvelope } from './avatar/mouth.ts';
import { drawAvatar, frameAt, shouldAnimate } from './avatar/renderer.ts';
import type { AvatarAssets } from './avatar/assets.ts';

const facts = (values: Partial<AvatarFacts> = {}): AvatarFacts => ({ epoch: 0, welcome: false, speech: { status: 'idle' }, dictation: { status: 'idle' }, ...values });
const chat = { id: 'latest', status: 'streaming' as const, hasText: false, toolRunning: false, hasArtifacts: false };

test('actual speech owns the selected old message even during a new streamed reply', () => {
  const state = advanceAvatar(createController(0), facts({ chat: { ...chat, hasText: true }, speech: { status: 'playing', messageId: 'old', sessionId: 's1' } }), 0);
  assert.equal(avatarForMessage(state.view, 'old').activity, 'speaking');
  assert.equal(avatarForMessage(state.view, 'latest').target, undefined);
  assert.equal(avatarForMessage(state.view, 'unrelated').target, undefined);
  assert.equal(state.view.action, undefined);
});

test('text and tools never drive a speaking mouth, and a single tool completion cannot celebrate', () => {
  assert.equal(hasTravelResult([{ kind: 'places', places: [] }, { kind: 'routes', routes: [] }]), false);
  assert.equal(hasTravelResult(undefined), false);
  let state = advanceAvatar(createController(0), facts({ chat }), 0);
  assert.equal(state.view.activity, 'thinking');
  state = advanceAvatar(state, facts({ chat: { ...chat, hasText: true } }), 10);
  assert.equal(state.view.activity, 'idle');
  state = advanceAvatar(state, facts({ chat: { ...chat, hasText: true, toolRunning: true } }), 20);
  assert.equal(state.view.activity, 'thinking');
  state = advanceAvatar(state, facts({ chat: { ...chat, hasText: true, toolRunning: false } }), 30);
  assert.equal(state.view.action, undefined);
  state = advanceAvatar(state, facts({ chat: { ...chat, status: 'complete', hasArtifacts: true } }), 40);
  assert.equal(state.view.action?.kind, 'nodding');
});

test('permission, connection, recording, finishing, failure and voluntary cancellation stay distinct', () => {
  for (const status of ['permission', 'connecting', 'recording', 'finishing'] as const) {
    const state = advanceAvatar(createController(0), facts({ welcome: true, dictation: { status } }), 0);
    assert.equal(state.view.activity, status === 'recording' ? 'listening' : 'waiting');
    assert.equal(state.view.action, undefined);
    assert.equal(state.view.expression, 'neutral');
  }
  let state = advanceAvatar(createController(0), facts({ chat: { ...chat, status: 'error' } }), 0);
  assert.equal(state.view.expression, 'concerned');
  state = advanceAvatar(state, facts({ chat: { ...chat, status: 'stopped' } }), 10);
  assert.equal(state.view.expression, 'neutral');
  assert.equal(state.view.action, undefined);
});

test('welcome and completion actions retain IDs and never replay after rerenders or remounts', () => {
  let state = advanceAvatar(createController(0), facts({ welcome: true }), 100);
  const action = state.view.action!;
  state = advanceAvatar(state, facts({ welcome: true }), 500);
  assert.equal(state.view.action, action);
  state = advanceAvatar(state, facts({ welcome: true }), 2000);
  assert.equal(state.view.action, undefined);
  state = advanceAvatar(state, facts({ welcome: true }), 3000);
  assert.equal(state.view.action, undefined);
  const complete = facts({ speech: { messageId: 'old', sessionId: 's1', status: 'complete' } });
  state = advanceAvatar(state, complete, 4000);
  assert.equal(state.view.action?.id, 'speech:s1');
  state = advanceAvatar(state, complete, 6000);
  assert.equal(state.view.action, undefined);
  state = advanceAvatar(state, facts({ speech: { ...complete.speech, sessionId: 'replay' } }), 7000);
  assert.equal(state.view.action?.id, 'speech:replay');
});

test('new conversation discards actions and stale facts/timers cannot restore old state', () => {
  let state = advanceAvatar(createController(0), facts({ chat: { ...chat, status: 'complete', hasArtifacts: true } }), 10);
  const old = state.view.action!;
  state = advanceAvatar(state, facts({ epoch: 1, welcome: true }), 20);
  const reset = state;
  assert.equal(expireAction(state, old.id, old.epoch), reset);
  assert.equal(advanceAvatar(state, facts({ speech: { status: 'playing', messageId: 'old' } }), 30), reset);
  assert.equal(state.view.messageId, undefined);
  assert.equal(state.view.action?.id, 'welcome:1');
});

test('suppressed completion events are consumed rather than queued behind live work', () => {
  const speech = { messageId: 'old', sessionId: 'done', status: 'complete' as const };
  let state = advanceAvatar(createController(0), facts({ chat, speech }), 0);
  assert.equal(state.view.activity, 'thinking');
  state = advanceAvatar(state, facts({ speech }), 100);
  assert.equal(state.view.action, undefined);
});

test('volume mapping has four levels, hysteresis, silence reset and no O viseme inference', () => {
  const mouth = new MouthEnvelope();
  assert.equal(mouth.sample(0, 33), 'closed');
  for (const [level, expected] of [[.03, 'slight_open'], [.08, 'medium_open'], [.3, 'wide_open']] as const) {
    mouth.reset();
    for (let i = 0; i < 12; i++) mouth.sample(level, 33);
    assert.equal(mouth.sample(level, 33), expected);
  }
  assert.equal(mouth.sample(.001, 33), 'closed');
  mouth.sample(.4, 100);
  assert.equal(mouth.reset(), 'closed');
  assert.equal(mouth.sample(Number.NaN, 33), 'closed');
});

test('reduced motion, hidden pages and offscreen hosts never schedule visual animation', () => {
  assert.equal(shouldAnimate(true, true, false, false), true);
  for (const input of [[false,true,false,false], [true,false,false,false], [true,true,true,false], [true,true,false,true]]) assert.equal(shouldAnimate(...input as [boolean,boolean,boolean,boolean]), false);
});

test('renderer replaces one mouth on a bare face, keeps registered coordinates, then covers brows with hair', () => {
  const calls: unknown[][] = [];
  const ctx = { imageSmoothingEnabled: true, clearRect() {}, save() {}, restore() {}, translate() {}, drawImage(...args: unknown[]) { calls.push(args); } };
  const features = Object.fromEntries(['eyes_open','eyebrows_neutral','mouth_closed','mouth_wide_open'].map((id,i) => [id, { x:i*128,y:0,w:128,h:128 }]));
  const assets = { base:'bare-face',front:'hair',sheet:'features',entry:{width:128,height:128,features} } as unknown as AvatarAssets;
  drawAvatar(ctx as unknown as CanvasRenderingContext2D, assets, { epoch:0,activity:'idle',expression:'neutral' }, 'wide_open', 0, true);
  assert.equal(calls[0]![0], 'bare-face');
  assert.equal(calls.at(-1)![0], 'hair');
  assert.deepEqual(calls[3], ['features',256,0,128,128,0,0,128,128], 'text activity forces closed mouth despite an incoming level');
  calls.length = 0;
  drawAvatar(ctx as unknown as CanvasRenderingContext2D, assets, { epoch:0,activity:'speaking',expression:'neutral' }, 'wide_open', 0, true);
  assert.deepEqual(calls[3], ['features',384,0,128,128,0,0,128,128]);
  assert.equal(calls.length, 5, 'exactly one eye, brow and mouth layer');
  assert.equal(ctx.imageSmoothingEnabled, false);
  const frames = [{x:0,y:0,w:1,h:1,durationMs:40},{x:1,y:0,w:1,h:1,durationMs:100}];
  assert.equal(frameAt({file:'test',frames}, 50), frames[1]);
});
