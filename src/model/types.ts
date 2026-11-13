import type { ProtocolId } from '../protocols/registry';
import type { NodeKind } from '../protocols/nodeKinds';

export type ScenarioId = string; // kebab-case, equals file name in src/scenarios/data/
export type NodeId = string;
export type LinkId = string;
export type StepId = string;
export type PacketId = string;

export interface GridPoint {
  col: number;
  row: number;
} // isometric grid units; .5 allowed

export interface NodeAddresses {
  ipv4?: string;
  ipv6?: string;
  mac?: string;
  hostname?: string;
}

export interface NodeDef {
  id: NodeId;
  kind: NodeKind;
  label: string; // e.g. "Your laptop"
  sublabel?: string; // e.g. "192.168.1.23"
  position: GridPoint;
  zone?: string; // ZoneDef.id
  addresses?: NodeAddresses;
  sequence?: 'lane' | 'hidden'; // default from NODE_KINDS[kind].defaultSequence
}

export type ZoneTone = 'lan' | 'isp' | 'internet' | 'datacenter' | 'remote';
export interface ZoneDef {
  id: string;
  label: string;
  from: GridPoint;
  to: GridPoint;
  tone: ZoneTone;
}

export type LinkMedium = 'ethernet' | 'wifi' | 'wan' | 'backbone';
export interface LinkDef {
  id: LinkId;
  a: NodeId;
  b: NodeId;
  medium: LinkMedium;
  label?: string;
  via?: GridPoint[];
  mtu?: number;
}

export type Layer = 'link' | 'internet' | 'transport' | 'application';
export interface HeaderField {
  name: string;
  value: string;
  note?: string;
}
export interface HeaderGroup {
  layer: Layer;
  protocol: ProtocolId;
  title?: string;
  fields: HeaderField[];
}

export type TcpFlag = 'SYN' | 'ACK' | 'FIN' | 'RST' | 'PSH';
export interface TcpMeta {
  conn: string; // connection id, same for both directions
  srcPort: number;
  dstPort: number;
  seq: number;
  ack?: number; // absolute values; UI shows relative too
  flags: TcpFlag[];
  len: number;
  window?: number;
  retransmission?: boolean; // seq may repeat
  resync?: boolean; // checker resets expectations (documented omission)
}
export interface Ipv4Meta {
  src: string;
  dst: string;
  ttl: number;
  id?: number;
  df?: boolean;
  mf?: boolean;
  fragOffset?: number; // offset in 8-byte units
  totalLength?: number;
}
export interface PacketMeta {
  tcp?: TcpMeta;
  ipv4?: Ipv4Meta;
}

export type PacketOutcome =
  | { kind: 'delivered' }
  | { kind: 'lost'; afterNode: NodeId; note: string } // vanishes on the hop leaving afterNode
  | { kind: 'dropped'; atNode: NodeId; note: string } // stops at a node on the route
  | { kind: 'blocked'; note: string }; // delivered on the wire, blocked by the browser

export interface PacketDef {
  id: PacketId;
  from: NodeId;
  to: NodeId;
  via?: NodeId[]; // route = [from, ...via, to]
  protocol: ProtocolId; // top-most protocol as a capture tool would label it
  label: string; // chip text, <= 18 chars
  summary: string; // table Info column
  headers: HeaderGroup[];
  payload?: string; // human summary or literal text lines
  sizeBytes?: number;
  encrypted?: boolean;
  at: number; // animation ms offset from step start (>= 0)
  hopMs?: number; // override per-hop travel time
  dwellMs?: number; // override pause at transit nodes
  wireTimeMs: number; // simulated capture time since scenario start
  delivery?: 'unicast' | 'broadcast';
  floodTo?: NodeId[]; // broadcast copies from `to` to these neighbours
  outcome?: PacketOutcome; // default delivered
  meta?: PacketMeta; // machine-checked fields
}

export type NodeActionKind =
  | 'process'
  | 'cache-lookup'
  | 'cache-hit'
  | 'cache-miss'
  | 'store'
  | 'verify'
  | 'encrypt'
  | 'decrypt'
  | 'render';
export interface NodeAction {
  id: string;
  node: NodeId;
  kind: NodeActionKind;
  label: string;
  at: number;
  durationMs: number;
}

export type RichText = string; // inline `code` and **bold** only
export type ContentBlock =
  | { type: 'p'; text: RichText }
  | { type: 'list'; ordered?: boolean; items: RichText[] }
  | { type: 'code'; text: string; caption?: string }
  | { type: 'callout'; tone: 'note' | 'tip' | 'warning'; text: RichText };

export interface Reference {
  label: string;
  url: string;
}

export interface StepDef {
  id: StepId;
  title: string; // <= 48 chars (sidebar)
  phase?: string; // PhaseDef.id
  summary: RichText; // <= 200 chars
  body: ContentBlock[]; // ~<= 180 words
  packets: PacketDef[]; // sorted by `at`
  actions?: NodeAction[];
  focus?: NodeId[];
  simplifications?: RichText[];
  references?: Reference[];
  tailMs?: number; // idle time after last event (default 600)
}

export interface PhaseDef {
  id: string;
  label: string;
}

export type ScenarioCategory = 'journey' | 'foundations' | 'network-services' | 'web' | 'email';

export interface ScenarioDef {
  id: ScenarioId;
  title: string;
  tagline: string;
  category: ScenarioCategory;
  order: number;
  protocols: ProtocolId[];
  nodes: NodeDef[];
  links: LinkDef[];
  zones?: ZoneDef[];
  phases?: PhaseDef[];
  steps: StepDef[];
  sequenceLanes?: NodeId[]; // explicit lane order; else first-appearance order
  addressAllowlist?: string[]; // real public addresses allowed (e.g. root servers)
}

/**
 * Identity function that type-checks a scenario literal against `ScenarioDef` while
 * preserving its literal types. Every file in `src/scenarios/data/` default-exports
 * `defineScenario({ ... })`.
 */
export function defineScenario<const T extends ScenarioDef>(s: T): T {
  return s;
}
