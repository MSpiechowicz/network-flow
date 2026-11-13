import { memo } from 'react';
import type { CSSProperties } from 'react';
import { usePlayback } from '../../engine/store';
import type { CompiledScenario } from '../../engine/compile';
import type { PlaybackState } from '../../engine/playback';
import { ACTION_ICON, ACTION_TINT } from './actionGlyphs';
import { sameStrings, selectActionBadges } from './sceneFrame';
import { BADGE_ROOM, actionChipWidth } from './sceneModel';
import type { SceneModel } from './sceneModel';
import styles from './scene.module.css';

const selectBadges = (s: PlaybackState, c: CompiledScenario): string[] =>
  selectActionBadges(c, s.stepIndex, s.timeMs);

const CHIP_HEIGHT = 24;
const CHIP_GAP = 8;

interface ActionLayerProps {
  model: SceneModel;
  compiled: CompiledScenario;
  labelScale: number;
}

/**
 * Local work on a device: a pulse ring on the ground while it runs, and a badge chip above the device
 * with the action's label until the step ends. Re-renders only when a badge appears or finishes.
 */
export const ActionLayer = memo(function ActionLayer({
  model,
  compiled,
  labelScale,
}: ActionLayerProps) {
  const keys = usePlayback(selectBadges, sameStrings);

  return (
    <g aria-hidden="true">
      {keys.map((key) => {
        const [index = '', running = '0'] = key.split('|');
        const action = compiled.actions[Number(index)];
        const node = action === undefined ? undefined : model.nodeById.get(action.def.node);

        if (action === undefined || node === undefined) {
          return null;
        }

        const kind = action.def.kind;
        const label = action.def.label;
        const width = actionChipWidth(label);
        const top = node.bounds.top + (node.hasBadge ? BADGE_ROOM : 0) + CHIP_GAP;

        return (
          <g
            key={action.def.id}
            className={styles.action}
            data-action={action.def.id}
            data-running={running === '1' ? 'true' : undefined}
            transform={`translate(${node.x} ${node.y})`}
            style={{ '--tint': ACTION_TINT[kind] } as CSSProperties}
          >
            {running === '1' ? (
              <ellipse className={styles.pulse} rx={node.ringRx} ry={node.ringRy} />
            ) : null}
            <g
              className={styles.actionChip}
              transform={`translate(0 ${-top}) scale(${labelScale})`}
            >
              <path className={styles.actionPointer} d="M-4 0L0 5L4 0Z" />
              <rect
                className={styles.actionBody}
                x={-width / 2}
                y={-CHIP_HEIGHT}
                width={width}
                height={CHIP_HEIGHT}
                rx={CHIP_HEIGHT / 2}
              />
              <g
                className={styles.actionIcon}
                transform={`translate(${-width / 2 + 15} ${-CHIP_HEIGHT / 2})`}
              >
                {ACTION_ICON[kind]}
              </g>
              <text className={styles.actionText} x={-width / 2 + 26} y={-CHIP_HEIGHT / 2 + 4.2}>
                {label}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
});
