import { describe, expect, it } from 'vitest';
import minimal from '../scenarios/__fixtures__/minimal';
import type { LinkDef, NodeDef, ScenarioDef } from '../model/types';
import {
  NODE_EXTENT,
  TILE,
  isoToScreen,
  linkPolyline,
  pointAlong,
  polylineFrom,
  sceneBounds,
} from './geometry';

const nodeAt = (id: string, col: number, row: number): NodeDef => ({
  id,
  kind: 'server',
  label: id,
  position: { col, row },
});

describe('isoToScreen', () => {
  it('uses a 128x64 tile', () => {
    expect(TILE).toEqual({ w: 128, h: 64 });
  });

  it('maps grid units to screen coordinates', () => {
    expect(isoToScreen({ col: 0, row: 0 })).toEqual({ x: 0, y: 0 });
    expect(isoToScreen({ col: 1, row: 0 })).toEqual({ x: 64, y: 32 });
    expect(isoToScreen({ col: 0, row: 1 })).toEqual({ x: -64, y: 32 });
    expect(isoToScreen({ col: 3, row: 2 })).toEqual({ x: 64, y: 160 });
  });

  it('supports half cells and lifts by z', () => {
    expect(isoToScreen({ col: 1.5, row: 0.5 })).toEqual({ x: 64, y: 64 });
    expect(isoToScreen({ col: 1, row: 1 }, 20)).toEqual({ x: 0, y: 44 });
  });
});

describe('linkPolyline', () => {
  const nodes = new Map([nodeAt('a', 0, 0), nodeAt('b', 2, 0)].map((n) => [n.id, n]));
  const link: LinkDef = {
    id: 'ab',
    a: 'a',
    b: 'b',
    medium: 'wan',
    via: [{ col: 1, row: 1 }],
  };

  it('runs from a through the via points to b', () => {
    expect(linkPolyline(link, nodes)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 64 },
      { x: 128, y: 64 },
    ]);
  });

  it('can be oriented from either end', () => {
    expect(polylineFrom(link, 'b', nodes)[0]).toEqual({ x: 128, y: 64 });
    expect(polylineFrom(link, 'a', nodes)[0]).toEqual({ x: 0, y: 0 });
  });

  it('rejects a link to a missing node', () => {
    expect(() => linkPolyline({ ...link, b: 'zzz' }, nodes)).toThrow(/missing node/);
  });
});

describe('pointAlong', () => {
  // An L shape: 100 right, then 100 down (screen y grows downwards).
  const polyline = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];

  it('returns the endpoints at 0 and 1', () => {
    expect(pointAlong(polyline, 0)).toMatchObject({ x: 0, y: 0, angle: 0 });
    const end = pointAlong(polyline, 1);

    expect(end).toMatchObject({ x: 100, y: 100 });
    expect(end.angle).toBeCloseTo(Math.PI / 2);
  });

  it('finds the midpoint by arc length, on the corner of a symmetric L', () => {
    const mid = pointAlong(polyline, 0.5);

    expect(mid.x).toBeCloseTo(100);
    expect(mid.y).toBeCloseTo(0);
  });

  it('interpolates inside a segment and reports its direction', () => {
    const p = pointAlong(polyline, 0.75);

    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(50);
    expect(p.angle).toBeCloseTo(Math.PI / 2);
  });

  it('clamps the fraction', () => {
    expect(pointAlong(polyline, -1)).toMatchObject({ x: 0, y: 0 });
    expect(pointAlong(polyline, 7)).toMatchObject({ x: 100, y: 100 });
  });

  it('handles polylines with a via point from a real link', () => {
    const nodes = new Map([nodeAt('a', 0, 0), nodeAt('b', 2, 0)].map((n) => [n.id, n]));
    const points = linkPolyline(
      { id: 'ab', a: 'a', b: 'b', medium: 'wan', via: [{ col: 1, row: 1 }] },
      nodes,
    );
    // Legs are 64 and 128 long (total 192): one third is the via point, the midpoint is 32 beyond it.
    const viaPoint = pointAlong(points, 1 / 3);
    const mid = pointAlong(points, 0.5);

    expect(viaPoint.x).toBeCloseTo(0);
    expect(viaPoint.y).toBeCloseTo(64);
    expect(mid.x).toBeCloseTo(32);
    expect(mid.y).toBeCloseTo(64);
    expect(mid.angle).toBeCloseTo(0);
  });

  it('copes with degenerate input', () => {
    expect(pointAlong([], 0.5)).toEqual({ x: 0, y: 0, angle: 0 });
    expect(pointAlong([{ x: 5, y: 6 }], 0.5)).toEqual({ x: 5, y: 6, angle: 0 });
    expect(
      pointAlong(
        [
          { x: 5, y: 6 },
          { x: 5, y: 6 },
        ],
        0.5,
      ),
    ).toEqual({ x: 5, y: 6, angle: 0 });
  });
});

describe('sceneBounds', () => {
  const unpadded = sceneBounds(minimal, 0);

  it('contains every node box and zone corner', () => {
    for (const node of minimal.nodes) {
      const p = isoToScreen(node.position);

      expect(p.x - NODE_EXTENT.left).toBeGreaterThanOrEqual(unpadded.x);
      expect(p.x + NODE_EXTENT.right).toBeLessThanOrEqual(unpadded.x + unpadded.width);
      expect(p.y - NODE_EXTENT.up).toBeGreaterThanOrEqual(unpadded.y);
      expect(p.y + NODE_EXTENT.down).toBeLessThanOrEqual(unpadded.y + unpadded.height);
    }

    for (const zone of minimal.zones ?? []) {
      for (const corner of [zone.from, zone.to]) {
        const p = isoToScreen(corner);

        expect(p.x).toBeGreaterThanOrEqual(unpadded.x);
        expect(p.x).toBeLessThanOrEqual(unpadded.x + unpadded.width);
        expect(p.y).toBeGreaterThanOrEqual(unpadded.y);
        expect(p.y).toBeLessThanOrEqual(unpadded.y + unpadded.height);
      }
    }
  });

  it('grows by the padding on every side', () => {
    const padded = sceneBounds(minimal, 40);

    expect(padded.x).toBe(unpadded.x - 40);
    expect(padded.y).toBe(unpadded.y - 40);
    expect(padded.width).toBe(unpadded.width + 80);
    expect(padded.height).toBe(unpadded.height + 80);
  });

  it('includes link via points beyond the nodes', () => {
    const def: ScenarioDef = {
      ...minimal,
      zones: [],
      links: [{ ...(minimal.links[0] as LinkDef), via: [{ col: 0, row: 40 }] }],
    };

    expect(sceneBounds(def, 0).y + sceneBounds(def, 0).height).toBe(
      isoToScreen({ col: 0, row: 40 }).y,
    );
  });

  it('returns a small box at the origin for an empty scenario', () => {
    const empty: ScenarioDef = { ...minimal, nodes: [], links: [], zones: [], steps: [] };

    expect(sceneBounds(empty, 10)).toEqual({ x: -10, y: -10, width: 20, height: 20 });
  });
});
