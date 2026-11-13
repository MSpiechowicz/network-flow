import { describe, expect, it } from 'vitest';
import { compileScenario } from '../../engine/compile';
import minimal from '../../scenarios/__fixtures__/minimal';
import { latestStartedPacketId } from './latestPacket';

const compiled = compileScenario(minimal);

describe('latestStartedPacketId', () => {
  it('returns the last packet of the step that has started', () => {
    const step = compiled.steps.find((s) => s.packetIndices.length > 0);
    if (step === undefined) throw new Error('fixture has no packets');

    const last = compiled.packets[step.packetIndices[step.packetIndices.length - 1] ?? 0];
    expect(latestStartedPacketId(compiled, step.index, step.endMs)).toBe(last?.def.id);
  });

  it('returns null for a step index that does not exist', () => {
    expect(latestStartedPacketId(compiled, 999, 0)).toBeNull();
  });
});
