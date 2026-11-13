import { memo, useCallback } from 'react';
import type { CompiledScenario } from '../../engine/compile';
import type { PlaybackState } from '../../engine/playback';
import { usePlayback, usePlaybackDispatch } from '../../engine/store';
import { PacketGlyph } from './PacketGlyph';
import { frameAt } from './sceneFrame';
import type { PacketFrame } from './sceneFrame';
import type { SceneModel } from './sceneModel';
import styles from './scene.module.css';

const selectFrame = (s: PlaybackState, c: CompiledScenario): PacketFrame =>
  frameAt(c, s.timeMs, s.motion === 'reduced');
const selectReduced = (s: PlaybackState): boolean => s.motion === 'reduced';
const selectSelected = (s: PlaybackState): string | null => s.selectedPacketId;

interface PacketLayerProps {
  model: SceneModel;
  /** Same viewBox as the scene, so packets land exactly on the links of the svg underneath. */
  viewBox: string;
  compiled: CompiledScenario;
  labelScale: number;
}

/**
 * Every visible packet. The only scene layer that re-renders on each tick. It is a second svg laid over
 * the scene with the same viewBox: the scene below is a single image for assistive technology, and the
 * packets, which can be focused and chosen, must not sit inside an image.
 */
export const PacketLayer = memo(function PacketLayer({
  model,
  viewBox,
  compiled,
  labelScale,
}: PacketLayerProps) {
  const frame = usePlayback(selectFrame);
  const reduced = usePlayback(selectReduced);
  const selectedId = usePlayback(selectSelected);
  const dispatch = usePlaybackDispatch();

  const select = useCallback(
    (packetId: string): void => {
      dispatch({ type: 'selectPacket', packetId, seek: true });
    },
    [dispatch],
  );

  return (
    <svg
      className={styles.overlay}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="Packets in flight"
      data-reduced={reduced ? 'true' : undefined}
    >
      {frame.items.map((item) => {
        const { def } = item.packet;
        // A broadcast copy travels from the receiver on to its neighbours.
        const fromId = item.copy === 0 ? def.from : item.hop.from;
        const toId = item.copy === 0 ? def.to : item.hop.to;
        const from = compiled.nodeById.get(fromId)?.label ?? fromId;
        const to = compiled.nodeById.get(toId)?.label ?? toId;

        return (
          <PacketGlyph
            key={`${item.packet.index}-${item.copy}`}
            item={item}
            model={model}
            timeMs={frame.timeMs}
            reduced={reduced}
            labelScale={labelScale}
            selected={def.id === selectedId}
            name={`${def.label}, from ${from} to ${to}`}
            onSelect={select}
          />
        );
      })}
    </svg>
  );
});
