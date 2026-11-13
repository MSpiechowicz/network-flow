import { describe, expect, it } from 'vitest';
import broadcast from '../scenarios/__fixtures__/broadcast';
import minimal from '../scenarios/__fixtures__/minimal';
import type { PacketDef, ScenarioDef, StepDef } from '../model/types';
import { compileScenario } from './compile';
import {
  DEFAULT_LINGER_MS,
  countStartedPackets,
  maxConcurrentPackets,
  selectActiveNodes,
  selectActivePackets,
  selectPacketRows,
  stepIndexAt,
} from './selectors';

const M = compileScenario(minimal);
const B = compileScenario(broadcast);

// Minimal: packet 0 hops [0,550] and [700,1600]; steps end at 2200 / 4400 / 7400.
// Broadcast: packet 0 [0,450] then copies [600,1150] (phone) and [600,1050] (router);
// packet 1 (lost after the switch) hops [1750,2300] and [2450,2900]; steps end 1750 / 3500 / 5250.

function withOutcome(outcome: PacketDef['outcome']): ScenarioDef {
  const step = minimal.steps[0] as StepDef;
  const packet = { ...(step.packets[0] as PacketDef), via: ['router'], outcome };

  return { ...minimal, steps: [{ ...step, packets: [packet] }] };
}

describe('stepIndexAt', () => {
  it('is half-open [start, end) with the last step including the end', () => {
    expect(stepIndexAt(M, 0)).toBe(0);
    expect(stepIndexAt(M, 2199)).toBe(0);
    expect(stepIndexAt(M, 2200)).toBe(1);
    expect(stepIndexAt(M, 4400)).toBe(2);
    expect(stepIndexAt(M, M.durationMs)).toBe(2);
  });

  it('clamps outside the range', () => {
    expect(stepIndexAt(M, -100)).toBe(0);
    expect(stepIndexAt(M, M.durationMs + 100)).toBe(2);
  });
});

describe('selectActivePackets', () => {
  it('has nothing before a packet starts', () => {
    // Step 2 starts at 2200; nothing from it is visible earlier, and step 1 packet is long gone.
    expect(selectActivePackets(M, 2199).map((a) => a.packet.def.id)).toEqual([]);
    expect(selectActivePackets(M, 2200).map((a) => a.packet.def.id)).toEqual(['p-syn-ack']);
  });

  it('keeps progress within [0, 1] at every sampled time', () => {
    for (const c of [M, B]) {
      for (let t = -50; t <= c.durationMs + 50; t += 25) {
        for (const active of selectActivePackets(c, t)) {
          expect(active.hopProgress).toBeGreaterThanOrEqual(0);
          expect(active.hopProgress).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('interpolates linearly along the hop while travelling', () => {
    const [active] = selectActivePackets(M, 275);

    expect(active).toMatchObject({ copy: 0, phase: 'travelling', hopProgress: 0.5 });
    expect(active?.hop.linkId).toBe('laptop-router');
  });

  it('dwells at the transit node between hops', () => {
    const [active] = selectActivePackets(M, 600);

    expect(active).toMatchObject({ phase: 'dwelling', hopProgress: 1 });
    expect(active?.hop.to).toBe('router');
  });

  it('lingers 400 ms after arriving, then disappears', () => {
    const arrival = M.packets[0]?.endMs ?? 0;

    expect(selectActivePackets(M, arrival - 1)[0]?.phase).toBe('travelling');
    expect(selectActivePackets(M, arrival)[0]).toMatchObject({ phase: 'arrived', hopProgress: 1 });
    expect(selectActivePackets(M, arrival + DEFAULT_LINGER_MS - 1)).toHaveLength(1);
    expect(selectActivePackets(M, arrival + DEFAULT_LINGER_MS)).toHaveLength(0);
  });

  it('honours a custom linger time', () => {
    const arrival = M.packets[0]?.endMs ?? 0;

    expect(selectActivePackets(M, arrival + 50, { lingerMs: 0 })).toHaveLength(0);
    expect(selectActivePackets(M, arrival + 500, { lingerMs: 1000 })).toHaveLength(1);
  });

  it('quantizes progress to 0 or 1 in reduced mode', () => {
    for (let t = 0; t <= M.durationMs; t += 20) {
      for (const active of selectActivePackets(M, t, { quantize: true })) {
        expect([0, 1]).toContain(active.hopProgress);
      }
    }

    expect(selectActivePackets(M, 100, { quantize: true })[0]?.hopProgress).toBe(0);
    expect(selectActivePackets(M, 400, { quantize: true })[0]?.hopProgress).toBe(1);
  });

  it('lists broadcast copies after the main packet, which dwells until they leave', () => {
    const before = selectActivePackets(B, 500);
    const during = selectActivePackets(B, 800);

    expect(before.map((a) => [a.copy, a.phase])).toEqual([[0, 'dwelling']]);
    expect(during.map((a) => [a.copy, a.hop.to, a.phase])).toEqual([
      [1, 'phone', 'travelling'],
      [2, 'router', 'travelling'],
    ]);
  });

  it('lets copies arrive and linger independently', () => {
    // Router copy lands at 1050, phone copy at 1150.
    const at = selectActivePackets(B, 1100);

    expect(at.map((a) => [a.copy, a.phase])).toEqual([
      [1, 'travelling'],
      [2, 'arrived'],
    ]);
  });

  it('flags a lost packet on the hop leaving afterNode and keeps it until the step ends', () => {
    // Lost packet: hop switch -> router is [2450, 2900]; step ends at 3500.
    const fading = selectActivePackets(B, 2600).find((a) => a.packet.def.id === 'p-dns-lost');
    // The step's time range is half-open: the boundary instant belongs to the next step.
    const after = selectActivePackets(B, 3499).find((a) => a.packet.def.id === 'p-dns-lost');
    const gone = selectActivePackets(B, 3500).find((a) => a.packet.def.id === 'p-dns-lost');

    expect(fading).toMatchObject({ phase: 'lost' });
    expect(fading?.hop).toMatchObject({ from: 'switch', to: 'router' });
    expect(fading?.hopProgress).toBeCloseTo(150 / 450);
    expect(after).toMatchObject({ phase: 'lost', hopProgress: 1 });
    expect(gone).toBeUndefined();
  });

  it('shows the hop before the lost hop as a normal travelling packet', () => {
    const early = selectActivePackets(B, 2000).find((a) => a.packet.def.id === 'p-dns-lost');

    expect(early?.phase).toBe('travelling');
    expect(early?.hop.to).toBe('switch');
  });

  it('stops a dropped packet at its node and flags it', () => {
    const c = compileScenario(withOutcome({ kind: 'dropped', atNode: 'router', note: 'x' }));

    expect(selectActivePackets(c, 300)[0]).toMatchObject({ phase: 'travelling' });
    expect(selectActivePackets(c, 560)[0]).toMatchObject({ phase: 'dropped', hopProgress: 1 });
    expect(selectActivePackets(c, 560)[0]?.hop.to).toBe('router');
    // Still flagged at the end of the step (auto-pause frame): 550 + 600 tail... step is 1150 long.
    expect(selectActivePackets(c, c.steps[0]?.endMs ?? 0)[0]?.phase).toBe('dropped');
    expect(selectActivePackets(c, (c.steps[0]?.endMs ?? 0) + 1)).toHaveLength(0);
  });

  it('arrives and then flags a blocked packet', () => {
    const c = compileScenario(withOutcome({ kind: 'blocked', note: 'CORS' }));
    const arrival = c.packets[0]?.endMs ?? 0;

    expect(selectActivePackets(c, arrival - 1)[0]?.phase).toBe('travelling');
    expect(selectActivePackets(c, arrival)[0]).toMatchObject({ phase: 'blocked', hopProgress: 1 });
    expect(selectActivePackets(c, arrival)[0]?.hop.to).toBe('server');
  });

  it('never shows a packet dropped at its sender', () => {
    const c = compileScenario(withOutcome({ kind: 'dropped', atNode: 'laptop', note: 'x' }));

    expect(selectActivePackets(c, 0)).toEqual([]);
  });
});

describe('selectActiveNodes', () => {
  it('highlights the sender while it sends and the receiver after arrival', () => {
    expect([...selectActiveNodes(M, 0, 100)]).toEqual(['laptop']);
    expect([...selectActiveNodes(M, 0, 1700)]).toEqual(['server']);
    expect(selectActiveNodes(M, 0, 2100).size).toBe(0);
  });

  it('highlights nodes running a local action', () => {
    // Action in step 3 runs [6000, 6800].
    expect(selectActiveNodes(M, 2, 6100).has('server')).toBe(true);
    expect(selectActiveNodes(M, 2, 6900).has('server')).toBe(false);
  });

  it('highlights flood recipients when their copy arrives', () => {
    expect([...selectActiveNodes(B, 0, 1160)].sort()).toEqual(['phone', 'router']);
  });

  it('does not highlight a receiver for a lost packet', () => {
    const nodes = selectActiveNodes(B, 1, 2950);

    expect(nodes.size).toBe(0);
  });

  it('ignores an out-of-range step', () => {
    expect(selectActiveNodes(M, 9, 100).size).toBe(0);
  });
});

describe('selectPacketRows', () => {
  it('lists exactly the packets started up to now, marking the current step', () => {
    expect(selectPacketRows(M, 0, 0).map((r) => [r.packet.def.id, r.state])).toEqual([
      ['p-syn', 'current'],
    ]);
    expect(selectPacketRows(M, 1, 2200).map((r) => [r.packet.def.id, r.state])).toEqual([
      ['p-syn', 'past'],
      ['p-syn-ack', 'current'],
    ]);
    expect(selectPacketRows(M, 2, M.durationMs)).toHaveLength(3);
  });

  it('matches countStartedPackets for every sampled time', () => {
    for (let t = 0; t <= M.durationMs; t += 50) {
      expect(countStartedPackets(M, t)).toBe(selectPacketRows(M, stepIndexAt(M, t), t).length);
    }
  });
});

describe('maxConcurrentPackets', () => {
  it('counts a flood packet with its copies and respects the linger', () => {
    // Fixture broadcast: at 800 only the two copies are on screen.
    expect(maxConcurrentPackets(B)).toBe(2);
  });

  it('is 1 for a scenario that never overlaps packets', () => {
    expect(maxConcurrentPackets(M)).toBe(1);
  });

  it('counts overlapping packets in one step', () => {
    const step = minimal.steps[0] as StepDef;
    const first = step.packets[0] as PacketDef;
    const def: ScenarioDef = {
      ...minimal,
      steps: [
        {
          ...step,
          packets: [
            { ...first, id: 'a', via: ['router'], at: 0 },
            { ...first, id: 'b', via: ['router'], at: 100 },
            { ...first, id: 'c', via: ['router'], at: 200 },
          ],
        },
      ],
    };

    expect(maxConcurrentPackets(compileScenario(def))).toBe(3);
  });
});
