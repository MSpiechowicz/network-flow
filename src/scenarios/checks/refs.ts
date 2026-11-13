import type { PacketDef, ScenarioDef, StepDef } from '../../model/types';

/** A packet together with where it sits in the scenario. */
export interface PacketRef {
  stepIndex: number;
  packetIndex: number;
  step: StepDef;
  packet: PacketDef;
  /** For example `steps[2].packets[0]`. */
  path: string;
}

/** Every packet in scenario order: steps in order, packets in their listed order. */
export function listPacketRefs(def: ScenarioDef): PacketRef[] {
  const refs: PacketRef[] = [];

  def.steps.forEach((step, stepIndex) => {
    step.packets.forEach((packet, packetIndex) => {
      refs.push({
        stepIndex,
        packetIndex,
        step,
        packet,
        path: `steps[${stepIndex}].packets[${packetIndex}]`,
      });
    });
  });

  return refs;
}

/** The nodes a packet visits in order: `[from, ...via, to]`. */
export function routeOf(packet: PacketDef): string[] {
  return [packet.from, ...(packet.via ?? []), packet.to];
}
