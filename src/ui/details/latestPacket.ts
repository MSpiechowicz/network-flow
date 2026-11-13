import type { CompiledScenario } from '../../engine/compile';
import type { PacketId } from '../../model/types';

/**
 * The most recently sent packet of a step at `timeMs` (the last one with `startMs <= timeMs`), or
 * `null` when none has started yet. A primitive, so it is cheap to use as a store selector.
 */
export function latestStartedPacketId(
  c: CompiledScenario,
  stepIndex: number,
  timeMs: number,
): PacketId | null {
  const step = c.steps[stepIndex];
  if (step === undefined) {
    return null;
  }

  let latest: PacketId | null = null;

  for (const index of step.packetIndices) {
    const packet = c.packets[index];
    if (packet !== undefined && packet.startMs <= timeMs) {
      latest = packet.def.id;
    }
  }

  return latest;
}
