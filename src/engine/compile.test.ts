import { describe, expect, it } from 'vitest';
import broadcast from '../scenarios/__fixtures__/broadcast';
import minimal from '../scenarios/__fixtures__/minimal';
import type { PacketDef, ScenarioDef, StepDef } from '../model/types';
import { DEFAULT_DWELL_MS, DEFAULT_HOP_MS, DEFAULT_TAIL_MS, compileScenario } from './compile';

/** The minimal fixture with one extra packet/step tweak applied, for targeted cases. */
function withStep(step: Partial<StepDef> & { packets: PacketDef[] }): ScenarioDef {
  const template = minimal.steps[0] as StepDef;

  return { ...minimal, steps: [{ ...template, ...step }] };
}

const syn = (minimal.steps[0] as StepDef).packets[0] as PacketDef;

describe('compileScenario', () => {
  it('makes steps contiguous from time zero and reports the duration', () => {
    const c = compileScenario(minimal);

    expect(c.steps).toHaveLength(3);
    expect(c.steps[0]?.startMs).toBe(0);
    for (let i = 1; i < c.steps.length; i++) {
      expect(c.steps[i]?.startMs).toBe(c.steps[i - 1]?.endMs);
    }
    expect(c.durationMs).toBe(c.steps[2]?.endMs);
    expect(c.durationMs).toBe(7400);
  });

  it('includes the dwell between hops: hop k starts at start + k*hopMs + k*dwellMs', () => {
    const def = withStep({
      packets: [{ ...syn, via: ['router'], hopMs: 400, dwellMs: 100, at: 50 }],
    });
    const hops = compileScenario(def).packets[0]?.hops;

    expect(hops?.map((h) => [h.startMs, h.endMs])).toEqual([
      [50, 450],
      [550, 950],
    ]);
  });

  it('uses medium defaults for hop time and the default dwell', () => {
    const packet = compileScenario(minimal).packets[0];
    const wifi = DEFAULT_HOP_MS.wifi;
    const wan = DEFAULT_HOP_MS.wan;

    expect(packet?.hops[0]).toMatchObject({ linkId: 'laptop-router', startMs: 0, endMs: wifi });
    expect(packet?.hops[1]).toMatchObject({
      linkId: 'router-server',
      from: 'router',
      to: 'server',
      startMs: wifi + DEFAULT_DWELL_MS,
      endMs: wifi + DEFAULT_DWELL_MS + wan,
    });
    expect(packet?.startMs).toBe(0);
    expect(packet?.endMs).toBe(wifi + DEFAULT_DWELL_MS + wan);
  });

  it('offsets packets by `at` from the step start and absolute step time', () => {
    const c = compileScenario(minimal);
    const second = c.packets[1];

    expect(second?.stepIndex).toBe(1);
    expect(second?.startMs).toBe(c.steps[1]?.startMs);
    expect(c.steps[1]?.packetIndices).toEqual([1]);
  });

  it('applies the default tail of 600 ms and a tailMs override', () => {
    const lastHopEnd = 1600;
    const defaulted = compileScenario(withStep({ packets: [{ ...syn, via: ['router'] }] }));
    const custom = compileScenario(
      withStep({ packets: [{ ...syn, via: ['router'] }], tailMs: 1000 }),
    );
    const none = compileScenario(withStep({ packets: [{ ...syn, via: ['router'] }], tailMs: 0 }));

    expect(DEFAULT_TAIL_MS).toBe(600);
    expect(defaulted.steps[0]?.endMs).toBe(lastHopEnd + DEFAULT_TAIL_MS);
    expect(custom.steps[0]?.endMs).toBe(lastHopEnd + 1000);
    expect(none.steps[0]?.endMs).toBe(lastHopEnd);
  });

  it('lets a late local action extend the step', () => {
    const c = compileScenario(minimal);

    expect(c.actions).toHaveLength(1);
    expect(c.actions[0]).toMatchObject({ stepIndex: 2, startMs: 4400 + 1600, endMs: 4400 + 2400 });
    expect(c.steps[2]?.actionIndices).toEqual([0]);
    // 2400 (action end) beats the 1600 packet end.
    expect(c.steps[2]?.endMs).toBe(4400 + 2400 + DEFAULT_TAIL_MS);
  });

  it('gives an empty step just its tail', () => {
    const c = compileScenario(withStep({ packets: [] }));

    expect(c.steps[0]?.endMs).toBe(DEFAULT_TAIL_MS);
    expect(c.durationMs).toBe(DEFAULT_TAIL_MS);
  });

  it('compiles flood hops from the destination after the dwell', () => {
    const c = compileScenario(broadcast);
    const packet = c.packets[0];

    expect(packet?.hops).toHaveLength(1);
    expect(packet?.floodHops.map((h) => [h.from, h.to, h.linkId])).toEqual([
      ['switch', 'phone', 'phone-switch'],
      ['switch', 'router', 'switch-router'],
    ]);

    const arrival = DEFAULT_HOP_MS.ethernet;
    const floodStart = arrival + DEFAULT_DWELL_MS;
    expect(packet?.floodHops.map((h) => [h.startMs, h.endMs])).toEqual([
      [floodStart, floodStart + DEFAULT_HOP_MS.wifi],
      [floodStart, floodStart + DEFAULT_HOP_MS.ethernet],
    ]);
    // The packet and the step end with the slowest copy.
    expect(packet?.endMs).toBe(floodStart + DEFAULT_HOP_MS.wifi);
    expect(c.steps[0]?.endMs).toBe(floodStart + DEFAULT_HOP_MS.wifi + DEFAULT_TAIL_MS);
  });

  it('keeps the whole route for a lost packet but only the hops up to the one leaving afterNode', () => {
    const c = compileScenario(broadcast);
    const lost = c.packets[1];

    expect(lost?.route).toEqual(['phone', 'switch', 'router']);
    // afterNode is the switch, so the switch -> router hop (where it fades) is kept.
    expect(lost?.hops.map((h) => h.to)).toEqual(['switch', 'router']);
    expect(lost?.floodHops).toEqual([]);
  });

  it('truncates a lost packet earlier when afterNode is the sender', () => {
    const def = withStep({
      packets: [
        {
          ...syn,
          via: ['router'],
          outcome: { kind: 'lost', afterNode: 'laptop', note: 'gone' },
        },
      ],
    });
    const packet = compileScenario(def).packets[0];

    expect(packet?.hops.map((h) => h.to)).toEqual(['router']);
    expect(packet?.endMs).toBe(DEFAULT_HOP_MS.wifi);
  });

  it('stops a dropped packet at the node it arrives at', () => {
    const def = withStep({
      packets: [
        {
          ...syn,
          via: ['router'],
          outcome: { kind: 'dropped', atNode: 'router', note: 'filtered' },
        },
      ],
    });
    const packet = compileScenario(def).packets[0];

    expect(packet?.route).toEqual(['laptop', 'router', 'server']);
    expect(packet?.hops.map((h) => h.to)).toEqual(['router']);
    expect(packet?.endMs).toBe(DEFAULT_HOP_MS.wifi);
  });

  it('gives a packet dropped at its own sender no hops', () => {
    const def = withStep({
      packets: [{ ...syn, outcome: { kind: 'dropped', atNode: 'laptop', note: 'nope' } }],
    });
    const packet = compileScenario(def).packets[0];

    expect(packet?.hops).toEqual([]);
    expect(packet?.endMs).toBe(packet?.startMs);
  });

  it('keeps every hop for a blocked packet (delivered on the wire)', () => {
    const def = withStep({
      packets: [{ ...syn, via: ['router'], outcome: { kind: 'blocked', note: 'CORS' } }],
    });

    expect(compileScenario(def).packets[0]?.hops).toHaveLength(2);
  });

  it('indexes nodes and links in both directions', () => {
    const c = compileScenario(minimal);

    expect(c.nodeById.get('router')?.kind).toBe('router');
    expect(c.linkBetween('laptop', 'router')?.id).toBe('laptop-router');
    expect(c.linkBetween('router', 'laptop')?.id).toBe('laptop-router');
    expect(c.linkBetween('laptop', 'server')).toBeUndefined();
  });

  it('throws a descriptive error for a route step without a link', () => {
    const def = withStep({ packets: [{ ...syn, via: undefined }] });

    expect(() => compileScenario(def)).toThrow(/no link between "laptop" and "server"/);
  });

  it('throws when an outcome node is not on the route', () => {
    const def = withStep({
      packets: [
        {
          ...syn,
          via: ['router'],
          outcome: { kind: 'lost', afterNode: 'elsewhere', note: 'x' },
        },
      ],
    });

    expect(() => compileScenario(def)).toThrow(/not on the route/);
  });
});
