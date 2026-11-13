import type { CompiledHop, CompiledScenario } from '../../engine/compile';
import { TILE, isoToScreen, linkPolyline, polylineFrom } from '../../engine/geometry';
import type { Pt } from '../../engine/geometry';
import type { LinkDef, NodeDef, NodeId, ZoneDef, ZoneTone } from '../../model/types';
import { nodeKindInfo } from '../../protocols/nodeKinds';
import { KIND_TINT, kindBounds } from './devices';
import type { SpriteBounds } from './devices';
import { textWidth } from './textWidth';

/** Height of the label font on the zone plates, in screen px. */
export const ZONE_LABEL_FONT = 11;
const ZONE_LABEL_CHAR = 8.3;
const ZONE_LABEL_INSET = 9;
/** Gap between a plate edge and lettering placed outside it (clears the plate's visible side). */
const ZONE_LABEL_OUTSET = 12;
const ZONE_LABEL_OVERHANG = 24;
const ZONE_LABEL_END_INSET = 16;
const ZONE_LABEL_PAD = 5;
/** Depth of the plate's visible side, in screen px. */
export const ZONE_THICKNESS = 7;

export const NAME_FONT = 13;
export const SUB_FONT = 11;
const NAME_CHAR = 7.4;
const SUB_CHAR = 6.7;
/** Room above a device for its kind badge, and for the action chip that sits over that. */
export const BADGE_ROOM = 30;
export const ACTION_ROOM = 52;
const MIN_HALF_WIDTH = 84;
const MIN_HEADROOM = 58;
const SCENE_PAD = 16;
/** Labels, chips and dots grow by at most this factor when the scene is shrunk to fit a small panel. */
export const MAX_LABEL_SCALE = 1.4;
/** How much wider than its natural size an action chip may get, for the room the view reserves. */
const ACTION_CHIP_GROWTH = 1.25;

/** Width of an action badge chip with `label`, at scale 1: icon, text, padding. */
export function actionChipWidth(label: string): number {
  return Math.round(textWidth(label, 600, 11.5, 'sans', 6.6) + 38);
}

/** Room the devices at both ends of a link take from its length, in px. */
const LINK_LABEL_CLEARANCE = 110;

/** Screen length of one grid unit along either grid axis. */
const UNIT = Math.hypot(TILE.w / 2, TILE.h / 2);
const AXIS_COL: Pt = { x: TILE.w / 2 / UNIT, y: TILE.h / 2 / UNIT };
const AXIS_ROW: Pt = { x: -TILE.w / 2 / UNIT, y: TILE.h / 2 / UNIT };

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ViewBox extends Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneNode {
  def: NodeDef;
  x: number;
  y: number;
  tint: string;
  bounds: SpriteBounds;
  hasBadge: boolean;
  ringRx: number;
  ringRy: number;
  /** Baseline of the name and of the sublabel, relative to the node origin. */
  nameY: number;
  subY: number;
  /** Local-space box of the sprite with its badge chip. */
  spriteBox: Rect;
  /** Half width of the widest label line, at scale 1. */
  labelHalf: number;
  hasSub: boolean;
}

export interface SceneLink {
  def: LinkDef;
  points: Pt[];
  /** Path data from `def.a` to `def.b`, through the `via` points. */
  d: string;
  /** Label anchor on the longest segment, with the angle the text follows (kept upright). */
  label: { x: number; y: number; angle: number; width: number } | null;
}

export interface ZoneLabel {
  text: string;
  /** Font size of the lettering, in screen px. */
  fontSize: number;
  /** `matrix(a b c d e f)` that lays the text on the floor. Text is drawn at the local origin. */
  matrix: string;
  /** Backing parallelogram in local text space: `x, y, width, height`. */
  backing: { x: number; y: number; width: number; height: number };
  /** True when no candidate was free and the label needs its plate-coloured backing. */
  needsBacking: boolean;
  /** Corners of the label on screen, used for collision checks. */
  quad: Pt[];
}

export interface SceneZone {
  def: ZoneDef;
  tone: ZoneTone;
  corners: [Pt, Pt, Pt, Pt];
  /** Points attribute of the plate outline. */
  points: string;
  /** Path of the plate's visible side below the two front edges. */
  side: string;
  /** Inset outline path that gives the plate a bevelled look. */
  inset: string;
  /** Floor extent in grid units, used to place the label. */
  span: FloorSpan;
}

export interface SceneModel {
  viewBox: ViewBox;
  nodes: SceneNode[];
  /** Nodes sorted back to front by `col + row`. */
  nodesByDepth: SceneNode[];
  nodeById: ReadonlyMap<NodeId, SceneNode>;
  links: SceneLink[];
  zones: SceneZone[];
  /** Zone names placed for a label scale: first free edge position, one entry per zone, same order. */
  zoneLabels(labelScale: number): ZoneLabel[];
  /** Path data of the whole floor grid, in one element. */
  gridPath: string;
  /** Nodes that run a local action in any step, with their widest action chip; the scene reserves room. */
  actionNodes: ReadonlyMap<NodeId, number>;
  /** Polyline a packet follows across `hop`, ordered from `hop.from`. Cached per scenario. */
  hopPolyline(hop: CompiledHop): Pt[];
}

const cache = new WeakMap<CompiledScenario, SceneModel>();

/** Static geometry of a scenario; computed once per compiled scenario. */
export function sceneModelFor(c: CompiledScenario): SceneModel {
  const known = cache.get(c);
  if (known !== undefined) {
    return known;
  }

  const model = buildSceneModel(c);
  cache.set(c, model);

  return model;
}

export function buildSceneModel(c: CompiledScenario): SceneModel {
  const def = c.def;

  const actionNodes = new Map<NodeId, number>();
  for (const action of c.actions) {
    const width = actionChipWidth(action.def.label);
    actionNodes.set(action.def.node, Math.max(width, actionNodes.get(action.def.node) ?? 0));
  }

  const nodes = def.nodes.map(toSceneNode);
  const nodeById = new Map(nodes.map((node) => [node.def.id, node]));

  const links = def.links.map((link) => toSceneLink(link, c.nodeById));

  const zones = (def.zones ?? []).map(toSceneZone);

  const labelCache = new Map<number, ZoneLabel[]>();
  const zoneLabels = (labelScale: number): ZoneLabel[] => {
    const known = labelCache.get(labelScale);
    if (known !== undefined) {
      return known;
    }

    // Labels are drawn above links, so crossing one is a smaller fault than hiding behind a device.
    const obstacles: Obstacle[] = [
      ...links.flatMap(linkObstacles).map((shape) => ({ shape, weight: 1 })),
      ...nodes.flatMap((node) => [
        { shape: rectQuad(shiftRect(node.spriteBox, node.x, node.y)), weight: 6 },
        { shape: rectQuad(shiftRect(labelBoxFor(node, labelScale), node.x, node.y)), weight: 6 },
      ]),
    ];
    const labels = placeZoneLabels(zones, obstacles, labelScale);
    labelCache.set(labelScale, labels);

    return labels;
  };

  const depth = (node: SceneNode): number => node.def.position.col + node.def.position.row;
  const nodesByDepth = [...nodes].sort((a, b) => depth(a) - depth(b) || a.x - b.x);

  const viewBox = fitViewBox(nodes, zones, links, actionNodes);

  const hopCache = new Map<string, Pt[]>();
  const hopPolyline = (hop: CompiledHop): Pt[] => {
    const key = `${hop.linkId}|${hop.from}`;
    const known = hopCache.get(key);
    if (known !== undefined) {
      return known;
    }

    const link = def.links.find((candidate) => candidate.id === hop.linkId);
    const points = link === undefined ? [] : polylineFrom(link, hop.from, c.nodeById);
    hopCache.set(key, points);

    return points;
  };

  return {
    viewBox,
    nodes,
    nodesByDepth,
    nodeById,
    links,
    zones,
    zoneLabels,
    gridPath: gridPath(viewBox),
    actionNodes,
    hopPolyline,
  };
}

function toSceneNode(def: NodeDef): SceneNode {
  const { x, y } = isoToScreen(def.position);
  const bounds = kindBounds(def.kind);
  const hasBadge = nodeKindInfo(def.kind).badge !== undefined;

  const nameY = Math.max(bounds.bottom + 14, 44);
  const subY = nameY + 15;
  const nameWidth = def.label.length * NAME_CHAR;
  const subWidth = (def.sublabel?.length ?? 0) * SUB_CHAR;
  const labelHalf = Math.max(nameWidth, subWidth) / 2;

  const ringRx = Math.max(46, (bounds.right - bounds.left) / 2 + 4);

  return {
    def,
    x,
    y,
    tint: KIND_TINT[def.kind],
    bounds,
    hasBadge,
    ringRx,
    ringRy: ringRx / 2,
    nameY,
    subY,
    // Sprites are narrower towards the top, so the collision box is trimmed at the sides.
    spriteBox: {
      x0: bounds.left * 0.75,
      x1: bounds.right * 0.75,
      y0: -(bounds.top + (hasBadge ? BADGE_ROOM : 0)),
      y1: bounds.bottom,
    },
    labelHalf,
    hasSub: def.sublabel !== undefined,
  };
}

/** Baseline of a device's name at `scale`: bigger text grows downwards, never into the device. */
export function labelBaseline(node: SceneNode, scale: number): number {
  return node.nameY + (scale - 1) * 10;
}

/** Box of a device's name and address block at `scale`, in the device's local space. */
export function labelBoxFor(node: SceneNode, scale: number): Rect {
  const baseline = labelBaseline(node, scale);
  const lines = node.hasSub ? node.subY - node.nameY : 0;

  return {
    x0: -node.labelHalf * scale - 2,
    x1: node.labelHalf * scale + 2,
    y0: baseline - NAME_FONT * scale,
    y1: baseline + lines * scale + 4,
  };
}

function toSceneLink(link: LinkDef, nodes: ReadonlyMap<NodeId, NodeDef>): SceneLink {
  const points = linkPolyline(link, nodes);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join('');

  return { def: link, points, d, label: link.label === undefined ? null : linkLabel(link, points) };
}

function linkLabel(link: LinkDef, points: Pt[]): SceneLink['label'] {
  let best: { from: Pt; to: Pt; length: number } | null = null;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1] as Pt;
    const to = points[i] as Pt;
    const length = Math.hypot(to.x - from.x, to.y - from.y);

    if (best === null || length > best.length) {
      best = { from, to, length };
    }
  }

  if (best === null) {
    return null;
  }

  // A label longer than the free stretch of its link would run under the devices at either end.
  const width = (link.label?.length ?? 0) * 6.2;
  if (width > best.length - LINK_LABEL_CLEARANCE) {
    return null;
  }

  // Keep the text upright: read left to right.
  const left = best.from.x <= best.to.x ? best.from : best.to;
  const right = best.from.x <= best.to.x ? best.to : best.from;

  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
    angle: (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI,
    width,
  };
}

/** Link segments, and the label of a link, as collision shapes for zone labels. */
function linkObstacles(link: SceneLink): Pt[][] {
  const shapes: Pt[][] = [];

  for (let i = 1; i < link.points.length; i++) {
    shapes.push([link.points[i - 1] as Pt, link.points[i] as Pt]);
  }

  if (link.label !== null) {
    const { x, y, angle, width } = link.label;
    const radians = (angle * Math.PI) / 180;
    const ex = { x: Math.cos(radians), y: Math.sin(radians) };
    const ey = { x: -Math.sin(radians), y: Math.cos(radians) };
    const corner = (u: number, v: number): Pt => ({
      x: x + ex.x * u + ey.x * v,
      y: y + ex.y * u + ey.y * v,
    });

    shapes.push([
      corner(-width / 2, -16),
      corner(width / 2, -16),
      corner(width / 2, 2),
      corner(-width / 2, 2),
    ]);
  }

  return shapes;
}

function shiftRect(rect: Rect, dx: number, dy: number): Rect {
  return { x0: rect.x0 + dx, x1: rect.x1 + dx, y0: rect.y0 + dy, y1: rect.y1 + dy };
}

function rectQuad(rect: Rect): Pt[] {
  return [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
}

/* ------------------------------------------------------------------ zones */

type Edge = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
/** Where along the free stretch of an edge the lettering starts: 0 = at the start, 1 = at the far end. */
type Align = number;

interface FloorSpan {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

/** Something a zone label must stay clear of; `weight` ranks how bad crossing it is. */
interface Obstacle {
  shape: Pt[];
  weight: number;
}

interface LabelCandidate {
  label: ZoneLabel;
  fits: boolean;
}

const FRONT_EDGES: Edge[] = ['bottom-left', 'bottom-right'];
const ALIGN_ORDER: Align[] = [0, 1, 0.5, 0.25, 0.75, 0.125, 0.875, 0.375, 0.625];

function toSceneZone(def: ZoneDef): SceneZone {
  const span: FloorSpan = {
    c0: Math.min(def.from.col, def.to.col),
    c1: Math.max(def.from.col, def.to.col),
    r0: Math.min(def.from.row, def.to.row),
    r1: Math.max(def.from.row, def.to.row),
  };

  const corners: SceneZone['corners'] = [
    isoToScreen({ col: span.c0, row: span.r0 }),
    isoToScreen({ col: span.c1, row: span.r0 }),
    isoToScreen({ col: span.c1, row: span.r1 }),
    isoToScreen({ col: span.c0, row: span.r1 }),
  ];

  return {
    def,
    tone: def.tone,
    corners,
    points: pointsAttr(corners),
    side: sidePath(corners),
    inset: insetPath(span),
    span,
  };
}

/** One label per zone, each placed clear of the obstacles and of the labels placed before it. */
function placeZoneLabels(
  zones: readonly SceneZone[],
  obstacles: Obstacle[],
  scale: number,
): ZoneLabel[] {
  const placed: Obstacle[] = [];

  return zones.map((zone) => {
    const label = chooseZoneLabel(zone.def.label, zone.span, [...obstacles, ...placed], scale);
    placed.push({ shape: label.quad, weight: 6 });

    return label;
  });
}

function chooseZoneLabel(
  text: string,
  span: FloorSpan,
  obstacles: Obstacle[],
  scale: number,
): ZoneLabel {
  const width = text.length * ZONE_LABEL_CHAR * scale;

  const candidates: LabelCandidate[] = [];
  // One rule for every plate, so labels read consistently: lettered on the floor just outside the
  // plate's front-left edge, starting at its left corner. Other positions along that edge, then
  // the front-right edge, are used only when the preferred spot is crossed by a link or a device.
  for (const edge of FRONT_EDGES) {
    for (const align of ALIGN_ORDER) {
      candidates.push(labelCandidate(text, width, span, edge, align, scale, true));
    }
  }

  const usable = candidates.filter((candidate) => candidate.fits);
  const pool = usable.length > 0 ? usable : candidates;

  // Candidates are ordered by preference (all edges at their start, then at their end, then centred).
  let best: ZoneLabel | null = null;
  let bestScore = Infinity;

  for (const candidate of pool) {
    const cost = obstacles
      .filter((obstacle) => overlaps(candidate.label.quad, obstacle.shape))
      .reduce((sum, obstacle) => sum + obstacle.weight, 0);
    if (cost === 0) {
      return { ...candidate.label, needsBacking: false };
    }

    if (cost < bestScore) {
      bestScore = cost;
      best = candidate.label;
    }
  }

  const fallback = best ?? (candidates[0] as LabelCandidate).label;

  return { ...fallback, needsBacking: false };
}

function labelCandidate(
  text: string,
  width: number,
  span: FloorSpan,
  edge: Edge,
  align: Align,
  scale: number,
  outside: boolean,
): LabelCandidate {
  const colRun = edge === 'bottom-left' || edge === 'top-right';
  const edgeLength = ((colRun ? span.c1 - span.c0 : span.r1 - span.r0) * UNIT) | 0;
  // Lettering outside the plate may overhang the edge a little; inside it must fit with margins.
  const fits = outside
    ? width <= edgeLength + 2 * ZONE_LABEL_OVERHANG
    : width + 2 * ZONE_LABEL_END_INSET <= edgeLength;

  const font = ZONE_LABEL_FONT * scale;
  const inset = ZONE_LABEL_INSET / UNIT;
  const lift = (ZONE_LABEL_INSET + font) / UNIT;
  const outset = ZONE_LABEL_OUTSET / UNIT;
  const outsetLift = (ZONE_LABEL_OUTSET + font) / UNIT;
  const end = ZONE_LABEL_END_INSET / UNIT;
  const run = width / UNIT;

  let origin: Pt;
  let ex: Pt;
  let ey: Pt;

  if (colRun) {
    // Text reads along +col, its tops point towards -row.
    const row =
      edge === 'bottom-left'
        ? outside
          ? span.r1 + outsetLift
          : span.r1 - inset
        : outside
          ? span.r0 - outset
          : span.r0 + lift;
    const col = span.c0 + end + align * (span.c1 - span.c0 - 2 * end - run);

    origin = isoToScreen({ col, row });
    ex = AXIS_COL;
    ey = AXIS_ROW;
  } else {
    // Text reads along -row (up and to the right), its tops point towards -col.
    const col =
      edge === 'bottom-right'
        ? outside
          ? span.c1 + outsetLift
          : span.c1 - inset
        : outside
          ? span.c0 - outset
          : span.c0 + lift;
    const row = span.r1 - end - align * (span.r1 - span.r0 - 2 * end - run);

    origin = isoToScreen({ col, row });
    ex = { x: -AXIS_ROW.x, y: -AXIS_ROW.y };
    ey = AXIS_COL;
  }

  const pad = ZONE_LABEL_PAD;
  const local = { x: -pad, y: -font - pad, width: width + 2 * pad, height: font + 2 * pad + 2 };
  const toScreen = (u: number, v: number): Pt => ({
    x: origin.x + ex.x * u + ey.x * v,
    y: origin.y + ex.y * u + ey.y * v,
  });

  return {
    fits,
    label: {
      text,
      fontSize: font,
      matrix: `matrix(${round(ex.x, 4)} ${round(ex.y, 4)} ${round(ey.x, 4)} ${round(ey.y, 4)} ${round(origin.x)} ${round(origin.y)})`,
      backing: local,
      needsBacking: false,
      quad: [
        toScreen(local.x, local.y),
        toScreen(local.x + local.width, local.y),
        toScreen(local.x + local.width, local.y + local.height),
        toScreen(local.x, local.y + local.height),
      ],
    },
  };
}

function sidePath(corners: SceneZone['corners']): string {
  const [, b, c, d] = corners;
  const lower = (p: Pt): string => `${round(p.x)} ${round(p.y + ZONE_THICKNESS)}`;

  return `M${round(d.x)} ${round(d.y)}L${round(c.x)} ${round(c.y)}L${round(b.x)} ${round(b.y)}L${lower(b)}L${lower(c)}L${lower(d)}Z`;
}

function insetPath(span: FloorSpan): string {
  const gap = 0.14;
  const c0 = span.c0 + gap;
  const c1 = span.c1 - gap;
  const r0 = span.r0 + gap;
  const r1 = span.r1 - gap;

  if (c1 <= c0 || r1 <= r0) {
    return '';
  }

  return [
    isoToScreen({ col: c0, row: r0 }),
    isoToScreen({ col: c1, row: r0 }),
    isoToScreen({ col: c1, row: r1 }),
    isoToScreen({ col: c0, row: r1 }),
  ]
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
    .join('')
    .concat('Z');
}

/* ----------------------------------------------------------- collision math */

/** Separating-axis test for two convex shapes; a two-point shape is a segment. */
export function overlaps(a: Pt[], b: Pt[]): boolean {
  for (const shape of [a, b]) {
    for (let i = 0; i < shape.length; i++) {
      const p = shape[i] as Pt;
      const q = shape[(i + 1) % shape.length] as Pt;
      const axis = { x: q.y - p.y, y: p.x - q.x };

      if (axis.x === 0 && axis.y === 0) {
        continue;
      }

      const [minA, maxA] = project(a, axis);
      const [minB, maxB] = project(b, axis);

      if (maxA < minB || maxB < minA) {
        return false;
      }
    }
  }

  return true;
}

function project(shape: Pt[], axis: Pt): [number, number] {
  let min = Infinity;
  let max = -Infinity;

  for (const p of shape) {
    const value = p.x * axis.x + p.y * axis.y;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  return [min, max];
}

/* -------------------------------------------------------------- view + grid */

function fitViewBox(
  nodes: SceneNode[],
  zones: SceneZone[],
  links: SceneLink[],
  actionNodes: ReadonlyMap<NodeId, number>,
): ViewBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const grow = (x0: number, y0: number, x1: number, y1: number): void => {
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  };

  for (const node of nodes) {
    const label = labelBoxFor(node, MAX_LABEL_SCALE);
    const chipHalf = ((actionNodes.get(node.def.id) ?? 0) / 2) * ACTION_CHIP_GROWTH;
    const half = Math.max(
      -node.bounds.left,
      node.bounds.right,
      -label.x0,
      label.x1,
      chipHalf,
      MIN_HALF_WIDTH,
    );
    const headroom = Math.max(
      node.bounds.top +
        (node.hasBadge ? BADGE_ROOM : 0) +
        (actionNodes.has(node.def.id) ? ACTION_ROOM : 0),
      MIN_HEADROOM,
    );

    grow(node.x - half, node.y - headroom, node.x + half, node.y + label.y1 + 4);
  }

  for (const zone of zones) {
    for (const corner of zone.corners) {
      grow(corner.x, corner.y, corner.x, corner.y + ZONE_THICKNESS);
    }
  }

  for (const link of links) {
    for (const p of link.points) {
      grow(p.x, p.y, p.x, p.y);
    }
  }

  if (minX > maxX) {
    return { x0: -100, y0: -100, x1: 100, y1: 100, x: -100, y: -100, width: 200, height: 200 };
  }

  const x0 = Math.floor(minX - SCENE_PAD);
  const y0 = Math.floor(minY - SCENE_PAD);
  const x1 = Math.ceil(maxX + SCENE_PAD);
  const y1 = Math.ceil(maxY + SCENE_PAD);

  return { x0, y0, x1, y1, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Floor grid lines covering `view`, as one path: lines along +col and along +row, one tile apart. */
function gridPath(view: Rect): string {
  const corners = [
    { x: view.x0, y: view.y0 },
    { x: view.x1, y: view.y0 },
    { x: view.x1, y: view.y1 },
    { x: view.x0, y: view.y1 },
  ].map((p) => ({
    col: (p.x / (TILE.w / 2) + p.y / (TILE.h / 2)) / 2,
    row: (p.y / (TILE.h / 2) - p.x / (TILE.w / 2)) / 2,
  }));

  const cols = corners.map((p) => p.col);
  const rows = corners.map((p) => p.row);
  const c0 = Math.floor(Math.min(...cols));
  const c1 = Math.ceil(Math.max(...cols));
  const r0 = Math.floor(Math.min(...rows));
  const r1 = Math.ceil(Math.max(...rows));

  const parts: string[] = [];
  const point = (col: number, row: number): string => {
    const p = isoToScreen({ col, row });

    return `${round(p.x)} ${round(p.y)}`;
  };

  for (let col = c0; col <= c1; col++) {
    parts.push(`M${point(col, r0)}L${point(col, r1)}`);
  }

  for (let row = r0; row <= r1; row++) {
    parts.push(`M${point(c0, row)}L${point(c1, row)}`);
  }

  return parts.join('');
}

function pointsAttr(points: readonly Pt[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}
