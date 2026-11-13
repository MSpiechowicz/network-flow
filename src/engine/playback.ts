import type { PacketId, ScenarioId } from '../model/types';
import type { CompiledPacket, CompiledScenario } from './compile';
import { stepIndexAt } from './selectors';

export const SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];
export type ViewMode = 'network' | 'sequence';
export type MotionPref = 'full' | 'reduced';

/** `prevStep` restarts the current step when more than this far into it. */
export const PREV_STEP_RESTART_MS = 250;

export interface PlaybackState {
  scenarioId: ScenarioId;
  /** Invariant: `steps[stepIndex].startMs <= timeMs <= steps[stepIndex].endMs`. */
  stepIndex: number;
  timeMs: number;
  playing: boolean;
  speed: Speed;
  view: ViewMode;
  autoPauseAtStepEnd: boolean;
  selectedPacketId: PacketId | null;
  motion: MotionPref;
}

export type PlaybackAction =
  | { type: 'load'; scenarioId: ScenarioId; stepIndex?: number; view?: ViewMode }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'tick'; deltaMs: number }
  | { type: 'seek'; timeMs: number }
  | { type: 'goToStep'; stepIndex: number; play?: boolean }
  | { type: 'nextStep' }
  | { type: 'prevStep' }
  | { type: 'firstStep' }
  | { type: 'lastStep' }
  | { type: 'setSpeed'; speed: Speed }
  | { type: 'speedUp' }
  | { type: 'speedDown' }
  | { type: 'setView'; view: ViewMode }
  | { type: 'toggleView' }
  | { type: 'selectPacket'; packetId: PacketId | null; seek?: boolean }
  | { type: 'setAutoPause'; value: boolean }
  | { type: 'setMotion'; motion: MotionPref };

export interface PlaybackContext {
  /** Must return the compiled scenario for a known id (it may throw for an unknown one). */
  getCompiled(id: ScenarioId): CompiledScenario;
}

/**
 * Defaults: step 0 at its start, paused, speed 1, network view, auto-pause on, nothing selected,
 * full motion. `partial` overrides them; `stepIndex` is clamped, a given `timeMs` is clamped into the
 * step and otherwise the step's start is used.
 */
export function initialPlaybackState(
  ctx: PlaybackContext,
  scenarioId: ScenarioId,
  partial?: Partial<PlaybackState>,
): PlaybackState {
  const c = ctx.getCompiled(scenarioId);

  const base: PlaybackState = {
    scenarioId,
    stepIndex: 0,
    timeMs: 0,
    playing: false,
    speed: 1,
    view: 'network',
    autoPauseAtStepEnd: false,
    selectedPacketId: null,
    motion: 'full',
    ...partial,
  };

  const stepIndex = clampStep(c, base.stepIndex);
  const step = c.steps[stepIndex];
  if (step === undefined) {
    return { ...base, scenarioId, stepIndex: 0, timeMs: 0, playing: false };
  }

  const timeMs =
    partial?.timeMs === undefined ? step.startMs : clamp(partial.timeMs, step.startMs, step.endMs);

  return { ...base, scenarioId, stepIndex, timeMs };
}

/**
 * Pure reducer. Interpretation choices where the spec leaves room:
 * - `goToStep` pauses unless `play` is true; `firstStep`/`lastStep` pause (`lastStep` goes to the
 *   start of the last step).
 * - `load` keeps speed, auto-pause, motion and (unless given) the view; it pauses and clears the
 *   selection. An unknown scenario id makes `ctx.getCompiled` throw; routing and the store
 *   resolve ids before dispatching.
 * - Whenever the step changes, a selected packet belonging to another step is deselected.
 * - `selectPacket` ignores ids that are not in the loaded scenario.
 * - `tick` ignores non-positive and non-finite deltas.
 */
export function reducePlayback(
  state: PlaybackState,
  action: PlaybackAction,
  ctx: PlaybackContext,
): PlaybackState {
  const c = ctx.getCompiled(state.scenarioId);

  switch (action.type) {
    case 'load':
      return load(state, action, ctx);

    case 'play':
      return play(state, c);

    case 'pause':
      return state.playing ? { ...state, playing: false } : state;

    case 'toggle':
      return state.playing ? { ...state, playing: false } : play(state, c);

    case 'tick':
      return tick(state, action.deltaMs, c);

    case 'seek':
      return seek(state, action.timeMs, c);

    case 'goToStep':
      return goToStep(state, c, action.stepIndex, action.play ?? false);

    case 'nextStep':
      return nextStep(state, c);

    case 'prevStep':
      return prevStep(state, c);

    case 'firstStep':
      return goToStep(state, c, 0, false);

    case 'lastStep':
      return goToStep(state, c, c.steps.length - 1, false);

    case 'setSpeed':
      return state.speed === action.speed ? state : { ...state, speed: action.speed };

    case 'speedUp':
      return shiftSpeed(state, 1);

    case 'speedDown':
      return shiftSpeed(state, -1);

    case 'setView':
      return state.view === action.view ? state : { ...state, view: action.view };

    case 'toggleView':
      return { ...state, view: state.view === 'network' ? 'sequence' : 'network' };

    case 'selectPacket':
      return selectPacket(state, c, action.packetId, action.seek ?? false);

    case 'setAutoPause':
      return state.autoPauseAtStepEnd === action.value
        ? state
        : { ...state, autoPauseAtStepEnd: action.value };

    case 'setMotion':
      return state.motion === action.motion ? state : { ...state, motion: action.motion };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampStep(c: CompiledScenario, stepIndex: number): number {
  if (!Number.isFinite(stepIndex)) {
    return 0;
  }

  return clamp(Math.trunc(stepIndex), 0, Math.max(0, c.steps.length - 1));
}

/** Moves to a time/step, dropping a selection that belongs to a different step. */
function moveTo(
  state: PlaybackState,
  c: CompiledScenario,
  stepIndex: number,
  timeMs: number,
  playing: boolean,
): PlaybackState {
  let selectedPacketId = state.selectedPacketId;

  if (selectedPacketId !== null && stepIndex !== state.stepIndex) {
    const selected = findPacket(c, selectedPacketId);
    if (selected === undefined || selected.stepIndex !== stepIndex) {
      selectedPacketId = null;
    }
  }

  if (
    stepIndex === state.stepIndex &&
    timeMs === state.timeMs &&
    playing === state.playing &&
    selectedPacketId === state.selectedPacketId
  ) {
    return state;
  }

  return { ...state, stepIndex, timeMs, playing, selectedPacketId };
}

function findPacket(c: CompiledScenario, id: PacketId): CompiledPacket | undefined {
  return c.packets.find((p) => p.def.id === id);
}

function load(
  state: PlaybackState,
  action: Extract<PlaybackAction, { type: 'load' }>,
  ctx: PlaybackContext,
): PlaybackState {
  return initialPlaybackState(ctx, action.scenarioId, {
    stepIndex: action.stepIndex ?? 0,
    view: action.view ?? state.view,
    speed: state.speed,
    autoPauseAtStepEnd: state.autoPauseAtStepEnd,
    motion: state.motion,
  });
}

/**
 * Where auto-pause parks at the end of a step. Steps are contiguous, so `endMs` is also the next
 * step's `startMs`; parking exactly there would already show the next step's first packets (and
 * keep this step's flagged packets visible in the next step). Parking a hair earlier keeps every
 * instant in exactly one step.
 */
export const STEP_END_EPSILON_MS = 1;

function stepPauseTime(step: { startMs: number; endMs: number }): number {
  return Math.max(step.startMs, step.endMs - STEP_END_EPSILON_MS);
}

function play(state: PlaybackState, c: CompiledScenario): PlaybackState {
  const step = c.steps[state.stepIndex];
  if (step === undefined) {
    return state;
  }

  // At the very end: restart from the beginning.
  if (state.timeMs >= c.durationMs) {
    return moveTo(state, c, 0, 0, true);
  }

  // At the end of a (not last) step: continue with the next one.
  const next = c.steps[state.stepIndex + 1];
  if (next !== undefined && state.timeMs >= stepPauseTime(step)) {
    return moveTo(state, c, next.index, next.startMs, true);
  }

  return state.playing ? state : { ...state, playing: true };
}

function tick(state: PlaybackState, deltaMs: number, c: CompiledScenario): PlaybackState {
  if (!state.playing || !(deltaMs > 0) || !Number.isFinite(deltaMs)) {
    return state;
  }

  const step = c.steps[state.stepIndex];
  if (step === undefined) {
    return state;
  }

  const timeMs = state.timeMs + deltaMs * state.speed;

  if (timeMs >= c.durationMs) {
    return moveTo(state, c, c.steps.length - 1, c.durationMs, false);
  }

  if (state.autoPauseAtStepEnd && timeMs >= step.endMs) {
    return moveTo(state, c, state.stepIndex, stepPauseTime(step), false);
  }

  const stepIndex = state.autoPauseAtStepEnd ? state.stepIndex : stepIndexAt(c, timeMs);

  return moveTo(state, c, stepIndex, timeMs, true);
}

function seek(state: PlaybackState, timeMs: number, c: CompiledScenario): PlaybackState {
  if (Number.isNaN(timeMs) || c.steps.length === 0) {
    return state;
  }

  const clamped = clamp(timeMs, 0, c.durationMs);

  return moveTo(state, c, stepIndexAt(c, clamped), clamped, state.playing);
}

function goToStep(
  state: PlaybackState,
  c: CompiledScenario,
  stepIndex: number,
  playing: boolean,
): PlaybackState {
  const step = c.steps[clampStep(c, stepIndex)];
  if (step === undefined) {
    return state;
  }

  return moveTo(state, c, step.index, step.startMs, playing);
}

function nextStep(state: PlaybackState, c: CompiledScenario): PlaybackState {
  const next = c.steps[state.stepIndex + 1];

  if (next === undefined) {
    // Last step: jump to the very end and stop.
    return c.steps.length === 0 ? state : moveTo(state, c, c.steps.length - 1, c.durationMs, false);
  }

  // With auto-pause on this is a guided "advance": it plays the step it lands on, then pauses.
  return moveTo(state, c, next.index, next.startMs, state.autoPauseAtStepEnd || state.playing);
}

function prevStep(state: PlaybackState, c: CompiledScenario): PlaybackState {
  const step = c.steps[state.stepIndex];
  if (step === undefined) {
    return state;
  }

  if (state.timeMs - step.startMs > PREV_STEP_RESTART_MS) {
    return moveTo(state, c, step.index, step.startMs, false);
  }

  const previous = c.steps[state.stepIndex - 1] ?? step;

  return moveTo(state, c, previous.index, previous.startMs, false);
}

function shiftSpeed(state: PlaybackState, direction: 1 | -1): PlaybackState {
  const index = SPEEDS.indexOf(state.speed);
  const speed = SPEEDS[clamp(index + direction, 0, SPEEDS.length - 1)] ?? state.speed;

  return speed === state.speed ? state : { ...state, speed };
}

function selectPacket(
  state: PlaybackState,
  c: CompiledScenario,
  packetId: PacketId | null,
  seekToPacket: boolean,
): PlaybackState {
  if (packetId === null) {
    return state.selectedPacketId === null ? state : { ...state, selectedPacketId: null };
  }

  const packet = findPacket(c, packetId);
  if (packet === undefined) {
    return state;
  }

  if (!seekToPacket) {
    return state.selectedPacketId === packetId ? state : { ...state, selectedPacketId: packetId };
  }

  // The packet's own step is used (not stepIndexAt), so a packet starting exactly at its step's end
  // still selects consistently; both satisfy the time/step invariant.
  return {
    ...state,
    stepIndex: packet.stepIndex,
    timeMs: packet.startMs,
    playing: false,
    selectedPacketId: packetId,
  };
}
