import { describe, expect, it } from 'vitest';
import broadcast from '../scenarios/__fixtures__/broadcast';
import minimal from '../scenarios/__fixtures__/minimal';
import type { ScenarioDef, ScenarioId } from '../model/types';
import { compileScenario } from './compile';
import type { CompiledScenario } from './compile';
import { SPEEDS, STEP_END_EPSILON_MS, initialPlaybackState, reducePlayback } from './playback';
import type { PlaybackAction, PlaybackContext, PlaybackState } from './playback';
import { stepIndexAt } from './selectors';

const compiled = new Map<ScenarioId, CompiledScenario>(
  [minimal, broadcast].map((def: ScenarioDef) => [def.id, compileScenario(def)]),
);

const ctx: PlaybackContext = {
  getCompiled(id) {
    const c = compiled.get(id);
    if (c === undefined) {
      throw new Error(`unknown ${id}`);
    }

    return c;
  },
};

// Minimal fixture timings: step starts 0 / 2200 / 4400, ends 2200 / 4400 / 7400.
const M = ctx.getCompiled('minimal');
const START = M.steps.map((s) => s.startMs);
const END = M.steps.map((s) => s.endMs);

function init(partial?: Partial<PlaybackState>): PlaybackState {
  return initialPlaybackState(ctx, 'minimal', partial);
}

function run(state: PlaybackState, ...actions: PlaybackAction[]): PlaybackState {
  return actions.reduce((s, a) => reducePlayback(s, a, ctx), state);
}

function expectInvariant(state: PlaybackState): void {
  const c = ctx.getCompiled(state.scenarioId);
  const step = c.steps[state.stepIndex];

  expect(step).toBeDefined();
  expect(state.timeMs).toBeGreaterThanOrEqual(step?.startMs ?? Infinity);
  expect(state.timeMs).toBeLessThanOrEqual(step?.endMs ?? -Infinity);
}

describe('initialPlaybackState', () => {
  it('starts paused at the first step with sensible defaults', () => {
    expect(init()).toEqual({
      scenarioId: 'minimal',
      stepIndex: 0,
      timeMs: 0,
      playing: false,
      speed: 1,
      view: 'network',
      autoPauseAtStepEnd: false,
      selectedPacketId: null,
      motion: 'full',
    });
  });

  it('applies overrides, clamping the step and placing time at its start', () => {
    const s = init({ stepIndex: 99, view: 'sequence', motion: 'reduced' });

    expect(s).toMatchObject({
      stepIndex: 2,
      timeMs: START[2],
      view: 'sequence',
      motion: 'reduced',
    });
  });
});

describe('tick', () => {
  it('advances by deltaMs times speed (2x)', () => {
    const s = run(init({ playing: true, speed: 2 }), { type: 'tick', deltaMs: 100 });

    expect(s.timeMs).toBe(200);
    expect(s.playing).toBe(true);
  });

  it('does nothing while paused', () => {
    const before = init();

    expect(run(before, { type: 'tick', deltaMs: 100 })).toBe(before);
  });

  it('ignores non-positive deltas', () => {
    const before = init({ playing: true });

    expect(run(before, { type: 'tick', deltaMs: 0 })).toBe(before);
    expect(run(before, { type: 'tick', deltaMs: -5 })).toBe(before);
  });

  it('auto-pause parks just before the step end, keeps the step and stops', () => {
    const s = run(init({ playing: true, autoPauseAtStepEnd: true, timeMs: END[0]! - 10 }), {
      type: 'tick',
      deltaMs: 500,
    });

    // Parking exactly on the boundary would already belong to the next step.
    expect(s).toMatchObject({
      stepIndex: 0,
      timeMs: END[0]! - STEP_END_EPSILON_MS,
      playing: false,
    });
    expect(stepIndexAt(M, s.timeMs)).toBe(0);
  });

  it('play after an auto-pause continues with the next step', () => {
    const paused = run(init({ playing: true, autoPauseAtStepEnd: true, timeMs: END[0]! - 10 }), {
      type: 'tick',
      deltaMs: 500,
    });
    const s = run(paused, { type: 'play' });

    expect(s).toMatchObject({ stepIndex: 1, timeMs: END[0], playing: true });
  });

  it('without auto-pause the step follows the time and playback continues', () => {
    const s = run(init({ playing: true, autoPauseAtStepEnd: false, timeMs: END[0]! - 10 }), {
      type: 'tick',
      deltaMs: 500,
    });

    expect(s.stepIndex).toBe(1);
    expect(s.timeMs).toBe(END[0]! + 490);
    expect(s.playing).toBe(true);
    expectInvariant(s);
  });

  it('clamps to the scenario duration and stops, with or without auto-pause', () => {
    for (const autoPauseAtStepEnd of [true, false]) {
      const s = run(
        init({ stepIndex: 2, playing: true, autoPauseAtStepEnd, timeMs: M.durationMs - 5 }),
        { type: 'tick', deltaMs: 100 },
      );

      expect(s).toMatchObject({ stepIndex: 2, timeMs: M.durationMs, playing: false });
    }
  });
});

describe('play, pause, toggle', () => {
  it('play from mid-step just starts playing', () => {
    const s = run(init({ timeMs: 500 }), { type: 'play' });

    expect(s).toMatchObject({ playing: true, timeMs: 500, stepIndex: 0 });
  });

  it('play from a step end advances to the next step start', () => {
    const s = run(init({ timeMs: END[0] }), { type: 'play' });

    expect(s).toMatchObject({ playing: true, stepIndex: 1, timeMs: START[1] });
  });

  it('play at the very end restarts from zero', () => {
    const s = run(init({ stepIndex: 2, timeMs: M.durationMs }), { type: 'play' });

    expect(s).toMatchObject({ playing: true, stepIndex: 0, timeMs: 0 });
  });

  it('pause and toggle flip the playing flag', () => {
    const playing = run(init(), { type: 'toggle' });
    const paused = run(playing, { type: 'toggle' });

    expect(playing.playing).toBe(true);
    expect(paused.playing).toBe(false);
    expect(run(playing, { type: 'pause' }).playing).toBe(false);
  });
});

describe('seek', () => {
  it('lands exactly on a step boundary in the later step', () => {
    const s = run(init(), { type: 'seek', timeMs: END[0]! });

    expect(s).toMatchObject({ stepIndex: 1, timeMs: START[1] });
    expect(stepIndexAt(M, END[0]! - 1)).toBe(0);
  });

  it('clamps beyond the duration into the last step and below zero to zero', () => {
    const past = run(init(), { type: 'seek', timeMs: M.durationMs + 5000 });
    const before = run(past, { type: 'seek', timeMs: -50 });

    expect(past).toMatchObject({ stepIndex: 2, timeMs: M.durationMs });
    expect(before).toMatchObject({ stepIndex: 0, timeMs: 0 });
  });

  it('leaves the playing flag alone', () => {
    expect(run(init({ playing: true }), { type: 'seek', timeMs: 100 }).playing).toBe(true);
    expect(run(init(), { type: 'seek', timeMs: 100 }).playing).toBe(false);
  });
});

describe('step navigation', () => {
  it('goToStep jumps to the step start, paused unless asked to play, and clamps', () => {
    expect(run(init(), { type: 'goToStep', stepIndex: 1 })).toMatchObject({
      stepIndex: 1,
      timeMs: START[1],
      playing: false,
    });
    expect(run(init(), { type: 'goToStep', stepIndex: 1, play: true }).playing).toBe(true);
    expect(run(init(), { type: 'goToStep', stepIndex: 40 }).stepIndex).toBe(2);
    expect(run(init({ stepIndex: 1 }), { type: 'goToStep', stepIndex: -3 }).stepIndex).toBe(0);
  });

  it('firstStep and lastStep go to the first and last step start, paused', () => {
    const last = run(init({ playing: true }), { type: 'lastStep' });

    expect(last).toMatchObject({ stepIndex: 2, timeMs: START[2], playing: false });
    expect(run(last, { type: 'firstStep' })).toMatchObject({ stepIndex: 0, timeMs: 0 });
  });

  it('nextStep with auto-pause on plays the step it lands on', () => {
    const s = run(init({ autoPauseAtStepEnd: true }), { type: 'nextStep' });

    expect(s).toMatchObject({ stepIndex: 1, timeMs: START[1], playing: true });
  });

  it('nextStep with auto-pause off only keeps playing if it was playing', () => {
    const paused = run(init({ autoPauseAtStepEnd: false }), { type: 'nextStep' });
    const playing = run(init({ autoPauseAtStepEnd: false, playing: true }), { type: 'nextStep' });

    expect(paused).toMatchObject({ stepIndex: 1, playing: false });
    expect(playing).toMatchObject({ stepIndex: 1, playing: true });
  });

  it('nextStep on the last step seeks to the end and pauses', () => {
    const s = run(init({ stepIndex: 2, playing: true }), { type: 'nextStep' });

    expect(s).toMatchObject({ stepIndex: 2, timeMs: M.durationMs, playing: false });
  });

  it('prevStep restarts the step when more than 250 ms in, else goes back a step', () => {
    const late = run(init({ stepIndex: 1, timeMs: START[1]! + 251, playing: true }), {
      type: 'prevStep',
    });
    const early = run(init({ stepIndex: 1, timeMs: START[1]! + 250, playing: true }), {
      type: 'prevStep',
    });

    expect(late).toMatchObject({ stepIndex: 1, timeMs: START[1], playing: false });
    expect(early).toMatchObject({ stepIndex: 0, timeMs: START[0], playing: false });
  });

  it('prevStep at the very start stays there, paused', () => {
    expect(run(init({ playing: true }), { type: 'prevStep' })).toMatchObject({
      stepIndex: 0,
      timeMs: 0,
      playing: false,
    });
  });

  it('prevStep from an auto-paused step end restarts that step', () => {
    const s = run(init({ stepIndex: 0, timeMs: END[0] }), { type: 'prevStep' });

    expect(s).toMatchObject({ stepIndex: 0, timeMs: 0 });
  });
});

describe('load', () => {
  it('clamps an out-of-range step, pauses, clears the selection and keeps preferences', () => {
    const before = init({
      playing: true,
      speed: 1.5,
      view: 'sequence',
      motion: 'reduced',
      autoPauseAtStepEnd: false,
      selectedPacketId: 'p-syn',
    });
    const s = run(before, { type: 'load', scenarioId: 'broadcast', stepIndex: 99 });

    expect(s).toEqual({
      scenarioId: 'broadcast',
      stepIndex: 2,
      timeMs: ctx.getCompiled('broadcast').steps[2]?.startMs,
      playing: false,
      speed: 1.5,
      view: 'sequence',
      autoPauseAtStepEnd: false,
      selectedPacketId: null,
      motion: 'reduced',
    });
  });

  it('takes the view from the action when given, and defaults to step 0', () => {
    const s = run(init({ view: 'sequence' }), {
      type: 'load',
      scenarioId: 'minimal',
      view: 'network',
    });

    expect(s).toMatchObject({ stepIndex: 0, timeMs: 0, view: 'network' });
  });
});

describe('speed, view, toggles', () => {
  it('speedUp and speedDown step through SPEEDS and saturate at the ends', () => {
    let s = init({ speed: SPEEDS[SPEEDS.length - 1] });
    expect(run(s, { type: 'speedUp' })).toBe(s);

    s = init({ speed: SPEEDS[0] });
    expect(run(s, { type: 'speedDown' })).toBe(s);

    expect(run(init({ speed: 1 }), { type: 'speedUp' }).speed).toBe(1.5);
    expect(run(init({ speed: 1 }), { type: 'speedDown' }).speed).toBe(0.5);
    expect(run(init(), { type: 'setSpeed', speed: 0.25 }).speed).toBe(0.25);
  });

  it('keeps time, step and selection when the view changes', () => {
    const before = init({ stepIndex: 1, timeMs: START[1]! + 100, selectedPacketId: 'p-syn-ack' });
    const after = run(before, { type: 'toggleView' });

    expect(after).toEqual({ ...before, view: 'sequence' });
    expect(run(after, { type: 'setView', view: 'network' }).view).toBe('network');
  });

  it('sets auto-pause and motion', () => {
    const s = run(
      init(),
      { type: 'setAutoPause', value: false },
      { type: 'setMotion', motion: 'reduced' },
    );

    expect(s).toMatchObject({ autoPauseAtStepEnd: false, motion: 'reduced' });
  });
});

describe('selectPacket', () => {
  it('with seek jumps to the packet start in its step and pauses', () => {
    const s = run(init({ playing: true }), { type: 'selectPacket', packetId: 'p-ack', seek: true });

    expect(s).toMatchObject({
      selectedPacketId: 'p-ack',
      stepIndex: 2,
      timeMs: M.packets[2]?.startMs,
      playing: false,
    });
    expectInvariant(s);
  });

  it('without seek only changes the selection', () => {
    const before = init({ timeMs: 300, playing: true });
    const s = run(before, { type: 'selectPacket', packetId: 'p-ack' });

    expect(s).toEqual({ ...before, selectedPacketId: 'p-ack' });
  });

  it('clears the selection with null and ignores unknown ids', () => {
    const selected = run(init(), { type: 'selectPacket', packetId: 'p-syn' });

    expect(run(selected, { type: 'selectPacket', packetId: null }).selectedPacketId).toBeNull();
    expect(run(selected, { type: 'selectPacket', packetId: 'nope' })).toBe(selected);
  });

  it('drops a selection that belongs to another step when the step changes', () => {
    const selected = run(init(), { type: 'selectPacket', packetId: 'p-syn' });

    expect(run(selected, { type: 'goToStep', stepIndex: 1 }).selectedPacketId).toBeNull();
    expect(run(selected, { type: 'seek', timeMs: 100 }).selectedPacketId).toBe('p-syn');
  });
});

/** Mulberry32: a small seeded PRNG so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAction(rand: () => number, c: CompiledScenario): PlaybackAction {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const packetIds = [...c.packets.map((p) => p.def.id), 'missing', null];

  const factories: (() => PlaybackAction)[] = [
    () => ({
      type: 'load',
      scenarioId: pick(['minimal', 'broadcast']),
      stepIndex: Math.floor(rand() * 8) - 2,
    }),
    () => ({ type: 'play' }),
    () => ({ type: 'pause' }),
    () => ({ type: 'toggle' }),
    () => ({ type: 'tick', deltaMs: rand() * 400 }),
    () => ({ type: 'tick', deltaMs: rand() * 400 }),
    () => ({ type: 'tick', deltaMs: rand() * 400 }),
    () => ({ type: 'seek', timeMs: (rand() * 1.4 - 0.2) * c.durationMs }),
    () => ({ type: 'seek', timeMs: pick(c.steps).endMs }),
    () => ({ type: 'goToStep', stepIndex: Math.floor(rand() * 8) - 2, play: rand() < 0.5 }),
    () => ({ type: 'nextStep' }),
    () => ({ type: 'prevStep' }),
    () => ({ type: 'firstStep' }),
    () => ({ type: 'lastStep' }),
    () => ({ type: 'setSpeed', speed: pick(SPEEDS) }),
    () => ({ type: 'speedUp' }),
    () => ({ type: 'speedDown' }),
    () => ({ type: 'toggleView' }),
    () => ({ type: 'selectPacket', packetId: pick(packetIds), seek: rand() < 0.5 }),
    () => ({ type: 'setAutoPause', value: rand() < 0.5 }),
    () => ({ type: 'setMotion', motion: pick(['full', 'reduced'] as const) }),
  ];

  return pick(factories)();
}

describe('invariant under random actions', () => {
  it.each([1, 2, 3, 4, 5, 6])('holds after 200 seeded random actions (seed %i)', (seed) => {
    const rand = prng(seed);
    let state = init();

    for (let i = 0; i < 200; i++) {
      const c = ctx.getCompiled(state.scenarioId);
      state = reducePlayback(state, randomAction(rand, c), ctx);

      const now = ctx.getCompiled(state.scenarioId);
      expectInvariant(state);
      expect(state.timeMs).toBeGreaterThanOrEqual(0);
      expect(state.timeMs).toBeLessThanOrEqual(now.durationMs);
      expect(Number.isInteger(state.stepIndex)).toBe(true);
    }
  });
});
