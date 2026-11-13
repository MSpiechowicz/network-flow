import type { CompiledScenario } from '../../engine/compile';
import type { NodeId, PacketDef } from '../../model/types';
import type { ProtocolId } from '../../protocols/registry';
import { protocolInfo } from '../../protocols/registry';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Simulated capture time since scenario start, scaled to its size:
 * `+12.4 ms` below one second, `+1.203 s` below a minute, then `+2:05` and `+12:00:00`.
 */
export function formatWireTime(wireTimeMs: number): string {
  const ms = Math.max(0, wireTimeMs);

  // Compare after rounding so 999.96 ms reads "1.000 s", never "1000.0 ms".
  if (Math.round(ms * 10) < MS_PER_SECOND * 10) {
    return `+${ms.toFixed(1)} ms`;
  }

  const wholeMs = Math.round(ms);
  if (wholeMs < SECONDS_PER_MINUTE * MS_PER_SECOND) {
    return `+${(wholeMs / MS_PER_SECOND).toFixed(3)} s`;
  }

  const seconds = Math.round(ms / MS_PER_SECOND);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const rest = twoDigits(seconds % SECONDS_PER_MINUTE);

  if (seconds < SECONDS_PER_HOUR) {
    return `+${String(minutes)}:${rest}`;
  }

  const hours = Math.floor(seconds / SECONDS_PER_HOUR);

  return `+${String(hours)}:${twoDigits(minutes)}:${rest}`;
}

/** Protocol column text; payloads carried inside TLS read "HTTP (in TLS)". */
export function protocolLabel(protocol: ProtocolId, encrypted: boolean | undefined): string {
  const label = protocolInfo(protocol).label;

  return encrypted === true && protocol !== 'tls' ? `${label} (in TLS)` : label;
}

/** Source/destination text: the address as captured, else the node's address, else its label. */
export function endpointText(
  compiled: CompiledScenario,
  nodeId: NodeId,
  captured: string | undefined,
): string {
  if (captured !== undefined) {
    return captured;
  }

  const node = compiled.nodeById.get(nodeId);
  if (node === undefined) {
    return nodeId;
  }

  return node.addresses?.ipv4 ?? node.addresses?.ipv6 ?? node.addresses?.hostname ?? node.label;
}

export function packetLength(def: PacketDef): string {
  const length = def.sizeBytes ?? def.meta?.ipv4?.totalLength;

  return length === undefined ? '—' : String(length);
}
