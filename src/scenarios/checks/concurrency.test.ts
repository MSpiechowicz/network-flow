import { describe, expect, it } from 'vitest';
import type { PacketDef, ScenarioDef, StepDef } from '../../model/types';
import broadcast from '../__fixtures__/broadcast';
import minimal from '../__fixtures__/minimal';
import { checkConcurrency, maxConcurrentInStep } from './concurrency';
import { buildTopology } from './topology';

/** laptop -wifi(550)- router -wan(900)- server, as in the minimal fixture. */
function packet(id: string, over: Partial<PacketDef> = {}): PacketDef {
  return {
    id,
    from: 'laptop',
    to: 'router',
    protocol: 'ipv4',
    label: id,
    summary: id,
    headers: [],
    at: 0,
    wireTimeMs: 0,
    ...over,
  };
}

function maxIn(packets: PacketDef[], scenario: ScenarioDef = minimal): number {
  const step = { id: 's', title: 't', summary: 's', body: [], packets } satisfies StepDef;

  return maxConcurrentInStep(step, buildTopology(scenario)).count;
}

describe('maxConcurrentInStep', () => {
  it('counts packets that overlap in time', () => {
    expect(maxIn([packet('a'), packet('b', { at: 100 }), packet('c', { at: 200 })])).toBe(3);
  });

  it('does not count a packet that arrived before the next one starts', () => {
    // laptop to router over wifi takes 550 ms; spans are half-open, so 550 is already free.
    expect(maxIn([packet('a'), packet('b', { at: 550 })])).toBe(1);
    expect(maxIn([packet('a'), packet('b', { at: 549 })])).toBe(2);
  });

  it('uses the per-link default hop time and dwell at transit nodes', () => {
    // laptop -> router -> server: 550 + 150 dwell + 900 = 1600 ms in total.
    const long = packet('long', { to: 'server', via: ['router'] });

    expect(maxIn([long, packet('b', { at: 1599 })])).toBe(2);
    expect(maxIn([long, packet('b', { at: 1600 })])).toBe(1);
  });

  it('honours per-packet hopMs and dwellMs overrides', () => {
    const quick = packet('quick', { to: 'server', via: ['router'], hopMs: 100, dwellMs: 0 });

    // 100 + 0 + 100 = 200 ms in total.
    expect(maxIn([quick, packet('b', { at: 199, hopMs: 100 })])).toBe(2);
    expect(maxIn([quick, packet('b', { at: 200, hopMs: 100 })])).toBe(1);
  });

  it('stops counting a lost packet on the hop leaving afterNode', () => {
    const lost = packet('lost', {
      to: 'server',
      via: ['router'],
      outcome: { kind: 'lost', afterNode: 'laptop', note: 'x' },
    });

    // Only the first hop (550 ms) is travelled.
    expect(maxIn([lost, packet('b', { at: 550 })])).toBe(1);
  });

  it('stops counting a dropped packet when it reaches atNode', () => {
    const dropped = packet('dropped', {
      to: 'server',
      via: ['router'],
      outcome: { kind: 'dropped', atNode: 'router', note: 'x' },
    });

    expect(maxIn([dropped, packet('b', { at: 550 })])).toBe(1);
  });

  it('counts broadcast copies after the main packet arrives', () => {
    const flood = broadcast.steps[0]?.packets[0];
    if (!flood) throw new Error('fixture has no flood packet');

    // The main packet plus two copies (phone, router). The copies start after the dwell at the
    // switch, so they overlap each other but not the main packet.
    expect(maxIn([flood], broadcast)).toBe(2);
  });

  it('ignores packets whose route does not resolve', () => {
    expect(maxIn([packet('ghost', { to: 'nowhere' })])).toBe(0);
  });
});

describe('checkConcurrency', () => {
  function withExtraPackets(count: number): ScenarioDef {
    const scenario = structuredClone(minimal) as ScenarioDef;
    const step = scenario.steps[0];
    if (!step) throw new Error('fixture has no step');
    for (let i = 0; i < count; i++) step.packets.push(packet(`extra-${i}`));

    return scenario;
  }

  it('allows exactly 12 packets at once', () => {
    // The fixture's own packet plus 11 extras.
    expect(checkConcurrency(withExtraPackets(11))).toEqual([]);
  });

  it('rejects 13 packets at once and names the step', () => {
    const issues = checkConcurrency(withExtraPackets(12));

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'error',
      code: 'concurrent-packets-exceeded',
      path: 'steps[0].packets',
    });
    expect(issues[0]?.message).toContain('13');
  });

  it('only compares packets inside the same step', () => {
    expect(checkConcurrency(minimal)).toEqual([]);
  });
});
