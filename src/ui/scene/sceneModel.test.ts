import { describe, expect, it } from 'vitest';
import { compileScenario } from '../../engine/compile';
import type { Pt } from '../../engine/geometry';
import { defineScenario } from '../../model/types';
import type { LinkDef, NodeDef, ZoneDef } from '../../model/types';
import broadcast from '../../scenarios/__fixtures__/broadcast';
import minimal from '../../scenarios/__fixtures__/minimal';
import { overlaps, sceneModelFor } from './sceneModel';

const plate: ZoneDef = {
  id: 'plate',
  label: 'Home LAN',
  from: { col: 0, row: 0 },
  to: { col: 5, row: 4 },
  tone: 'lan',
};

function scenarioWith(nodes: NodeDef[], links: LinkDef[], zones: ZoneDef[] = [plate]) {
  return defineScenario({
    ...minimal,
    nodes,
    links,
    zones,
    steps: [{ ...minimal.steps[0], packets: [], actions: [], focus: [] }],
  });
}

const node = (id: string, col: number, row: number): NodeDef => ({
  id,
  kind: 'laptop',
  label: id,
  position: { col, row },
});

describe('zone labels', () => {
  it('keep clear of every link and device in the shipped fixtures', () => {
    for (const def of [minimal, broadcast]) {
      const model = sceneModelFor(compileScenario(def));
      const labels = model.zoneLabels(1);

      expect(labels).toHaveLength(model.zones.length);

      for (const label of labels) {
        expect(label.needsBacking).toBe(false);

        for (const link of model.links) {
          for (let i = 1; i < link.points.length; i++) {
            const segment: Pt[] = [link.points[i - 1] as Pt, link.points[i] as Pt];
            expect(overlaps(label.quad, segment)).toBe(false);
          }
        }
      }
    }
  });

  it('move away from a link that runs across the preferred spot', () => {
    // A link along the plate's lower-left edge blocks the first candidate position.
    const def = scenarioWith(
      [node('a', 0.2, 3.8), node('b', 4.8, 3.8)],
      [{ id: 'a-b', a: 'a', b: 'b', medium: 'ethernet' }],
    );
    const model = sceneModelFor(compileScenario(def));
    const [label] = model.zoneLabels(1);
    const link = model.links[0];

    expect(label).toBeDefined();
    expect(label?.needsBacking).toBe(false);

    for (let i = 1; i < (link?.points.length ?? 0); i++) {
      const segment: Pt[] = [link?.points[i - 1] as Pt, link?.points[i] as Pt];
      expect(overlaps(label?.quad ?? [], segment)).toBe(false);
    }
  });

  it('are placed again, larger, when the scene is shrunk to fit', () => {
    const model = sceneModelFor(compileScenario(minimal));

    const normal = model.zoneLabels(1)[0];
    const grown = model.zoneLabels(1.4)[0];

    expect(grown?.fontSize).toBeGreaterThan(normal?.fontSize ?? Infinity);
  });
});

describe('scene fit', () => {
  it('contains every device with room for its label', () => {
    const compiled = compileScenario(minimal);
    const model = sceneModelFor(compiled);
    const { viewBox } = model;

    for (const placed of model.nodes) {
      expect(placed.x).toBeGreaterThan(viewBox.x0);
      expect(placed.x).toBeLessThan(viewBox.x1);
      // Sprite top and the label block both fit.
      expect(placed.y + placed.spriteBox.y0).toBeGreaterThanOrEqual(viewBox.y0);
      expect(placed.y + placed.subY + 6).toBeLessThanOrEqual(viewBox.y1);
    }
  });

  it('draws devices back to front', () => {
    const model = sceneModelFor(compileScenario(broadcast));
    const depth = model.nodesByDepth.map((n) => n.def.position.col + n.def.position.row);

    expect(depth).toEqual([...depth].sort((a, b) => a - b));
  });

  it('gives a packet exactly the link polyline in its direction of travel', () => {
    const compiled = compileScenario(minimal);
    const model = sceneModelFor(compiled);
    const hop = compiled.packets[0]?.hops[0];
    const link = model.links.find((l) => l.def.id === hop?.linkId);

    expect(hop).toBeDefined();
    expect(model.hopPolyline(hop!)).toEqual(link?.points);

    const back = compiled.packets[1]?.hops.at(-1);
    const backLink = model.links.find((l) => l.def.id === back?.linkId);
    expect(model.hopPolyline(back!)).toEqual([...(backLink?.points ?? [])].reverse());
  });
});
