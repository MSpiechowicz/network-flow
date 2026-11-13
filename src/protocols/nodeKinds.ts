/**
 * Node kinds: the closed set of device roles a `NodeDef.kind` may use.
 *
 * Adding a kind is a data-only change: add one entry below. A kind without its own sprite
 * maps to the generic `server` sprite and is told apart by its `badge`.
 */

/** Dedicated device sprites (one component each under `src/ui/scene/devices/`). */
export type SpriteId =
  | 'laptop'
  | 'phone'
  | 'router'
  | 'switch'
  | 'firewall'
  | 'cloud'
  | 'server'
  | 'cdn-edge'
  | 'mail-server'
  | 'observer';

export interface NodeKindInfo {
  /** Human-readable kind name, used in the text alternative and tooltips. */
  label: string;
  /** Whether nodes of this kind get a lane in the sequence view unless `NodeDef.sequence` overrides. */
  defaultSequence: 'lane' | 'hidden';
  /** Sprite to draw. */
  sprite: SpriteId;
  /** Short badge drawn on the sprite to distinguish kinds that share one (for example `'ROOT'`). */
  badge?: string;
}

export const NODE_KINDS = {
  laptop: { label: 'Laptop', defaultSequence: 'lane', sprite: 'laptop' },
  phone: { label: 'Phone', defaultSequence: 'lane', sprite: 'phone' },
  router: { label: 'Router', defaultSequence: 'hidden', sprite: 'router' },
  switch: { label: 'Switch', defaultSequence: 'hidden', sprite: 'switch' },
  firewall: { label: 'Firewall', defaultSequence: 'lane', sprite: 'firewall' },
  cloud: { label: 'Internet', defaultSequence: 'hidden', sprite: 'cloud' },
  'dns-resolver': {
    label: 'DNS resolver',
    defaultSequence: 'lane',
    sprite: 'server',
    badge: 'DNS',
  },
  'dns-root': {
    label: 'DNS root server',
    defaultSequence: 'lane',
    sprite: 'server',
    badge: 'ROOT',
  },
  'dns-tld': { label: 'DNS TLD server', defaultSequence: 'lane', sprite: 'server', badge: 'TLD' },
  'dns-authoritative': {
    label: 'Authoritative DNS server',
    defaultSequence: 'lane',
    sprite: 'server',
    badge: 'AUTH',
  },
  'cdn-edge': { label: 'CDN edge', defaultSequence: 'lane', sprite: 'cdn-edge' },
  'origin-server': { label: 'Origin server', defaultSequence: 'lane', sprite: 'server' },
  'api-server': { label: 'API server', defaultSequence: 'lane', sprite: 'server', badge: 'API' },
  'dhcp-server': {
    label: 'DHCP server',
    defaultSequence: 'lane',
    sprite: 'server',
    badge: 'DHCP',
  },
  'mail-server': { label: 'Mail server', defaultSequence: 'lane', sprite: 'mail-server' },
  observer: { label: 'Eavesdropper', defaultSequence: 'lane', sprite: 'observer' },
  server: { label: 'Server', defaultSequence: 'lane', sprite: 'server' },
} as const satisfies Record<string, NodeKindInfo>;

/** Every valid `NodeDef.kind`. A kind that is not a key of `NODE_KINDS` is a compile error. */
export type NodeKind = keyof typeof NODE_KINDS;

/** Typed lookup; use this instead of indexing `NODE_KINDS` so optional fields (`badge`) are readable. */
export function nodeKindInfo(kind: NodeKind): NodeKindInfo {
  return NODE_KINDS[kind];
}
