import { describe, expect, it } from 'vitest';
import { compileScenario } from '../../engine/compile';
import { defineScenario } from '../../model/types';
import type { ScenarioDef } from '../../model/types';
import broadcast from '../../scenarios/__fixtures__/broadcast';
import minimal from '../../scenarios/__fixtures__/minimal';
import { layoutSequence, sequenceLaneIds } from './sequenceLayout';

const fixtures: [string, ScenarioDef][] = [
  ['minimal', minimal],
  ['broadcast', broadcast],
];

describe('layoutSequence lanes', () => {
  it('leaves out hidden kinds that packets only pass through', () => {
    const layout = layoutSequence(compileScenario(minimal));

    // The router sits between the laptop and the server on every route.
    expect(layout.lanes.map((lane) => lane.nodeId)).toEqual(['laptop', 'server']);
  });

  it('honours an explicit lane order', () => {
    const reordered = defineScenario({ ...minimal, sequenceLanes: ['server', 'laptop'] });
    const layout = layoutSequence(compileScenario(reordered));

    expect(layout.lanes.map((lane) => lane.nodeId)).toEqual(['server', 'laptop']);
  });

  it('lets a node override its kind default with `sequence`', () => {
    const shown = defineScenario({
      ...minimal,
      nodes: minimal.nodes.map((node) =>
        node.id === 'router' ? { ...node, sequence: 'lane' as const } : node,
      ),
    });

    expect(sequenceLaneIds(compileScenario(shown))).toContain('router');
  });

  it('gives a hidden device a lane when it is itself the receiver', () => {
    const lanes = sequenceLaneIds(compileScenario(broadcast));

    expect(lanes).toContain('switch');
  });

  it('spaces lanes by the requested gap', () => {
    const layout = layoutSequence(compileScenario(minimal), { laneGap: 200, padLeft: 10 });

    expect(layout.lanes.map((lane) => lane.x)).toEqual([110, 310]);
  });
});

describe.each(fixtures)('layoutSequence arrows (%s)', (_name, def) => {
  const compiled = compileScenario(def);
  const layout = layoutSequence(compiled);

  it('draws exactly one arrow per packet', () => {
    expect(layout.arrows).toHaveLength(compiled.packets.length);
    expect(layout.arrows.map((arrow) => arrow.packetIndex)).toEqual(
      compiled.packets.map((packet) => packet.index),
    );
  });

  it('moves down the page as time passes', () => {
    const starts = compiled.packets.map((packet, i) => ({
      startMs: packet.startMs,
      y: layout.arrows[i]?.y1 ?? NaN,
    }));

    for (let i = 1; i < starts.length; i++) {
      const before = starts[i - 1];
      const after = starts[i];
      if (before !== undefined && after !== undefined && after.startMs > before.startMs) {
        expect(after.y).toBeGreaterThan(before.y);
      }
    }
  });

  it('never ends an arrow above where it starts', () => {
    for (const arrow of layout.arrows) {
      expect(arrow.y2).toBeGreaterThan(arrow.y1);
    }
  });

  it('maps time to y monotonically, across step boundaries too', () => {
    let previous = -Infinity;

    for (let t = 0; t <= compiled.durationMs; t += 100) {
      const y = layout.timeToY(t);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });

  it('stacks the step bands without gaps and fits them in the height', () => {
    expect(layout.stepBands).toHaveLength(compiled.steps.length);

    for (let i = 1; i < layout.stepBands.length; i++) {
      expect(layout.stepBands[i]?.y0).toBe(layout.stepBands[i - 1]?.y1);
    }

    expect(layout.height).toBeGreaterThan(layout.stepBands.at(-1)?.y1 ?? Infinity);
  });
});

describe('layoutSequence outcomes', () => {
  const compiled = compileScenario(broadcast);
  const layout = layoutSequence(compiled);

  it('stops a lost packet half way and marks the arrow', () => {
    const index = compiled.packets.findIndex((packet) => packet.def.outcome?.kind === 'lost');
    const arrow = layout.arrows[index];

    expect(arrow?.endKind).toBe('lost');

    const lanes = new Map(layout.lanes.map((lane) => [lane.nodeId, lane.x]));
    const from = lanes.get('phone') ?? NaN;
    const to = lanes.get('router') ?? NaN;
    expect(arrow?.x1).toBe(from);
    expect(arrow?.x2).toBeCloseTo((from + to) / 2);
  });

  it('keeps delivered arrows running lane to lane', () => {
    const index = compiled.packets.findIndex((packet) => packet.def.outcome === undefined);
    const arrow = layout.arrows[index];
    const packet = compiled.packets[index];

    expect(arrow?.endKind).toBe('delivered');
    expect(arrow?.x2).toBe(layout.lanes.find((lane) => lane.nodeId === packet?.def.to)?.x);
  });
});

describe('playheadY', () => {
  it.each(fixtures)('%s: never jumps, even across a step title', (_name, def) => {
    const compiled = compileScenario(def);
    const layout = layoutSequence(compiled);
    const stepMs = 16;
    // The fastest the playhead may move in one 16 ms frame: the tail plus one title row.
    const maxJump = 16;

    let previous = layout.playheadY(0);
    for (let t = stepMs; t <= compiled.durationMs; t += stepMs) {
      const y = layout.playheadY(t);
      expect(y).toBeGreaterThanOrEqual(previous);
      expect(y - previous).toBeLessThan(maxJump);
      previous = y;
    }
  });

  it('matches timeToY while packets are in flight', () => {
    const compiled = compileScenario(minimal);
    const layout = layoutSequence(compiled);

    for (const packet of compiled.packets) {
      expect(layout.playheadY(packet.startMs)).toBe(layout.timeToY(packet.startMs));
      expect(layout.playheadY(packet.endMs)).toBe(layout.timeToY(packet.endMs));
    }
  });
});
