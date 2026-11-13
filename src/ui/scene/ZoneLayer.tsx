import { memo, useMemo } from 'react';
import type { ZoneTone } from '../../model/types';
import { GRID_MASK_ID, urlRef } from './devices/ids';
import type { SceneModel } from './sceneModel';
import styles from './scene.module.css';

const TONE_CLASS: Record<ZoneTone, string> = {
  lan: styles.toneLan ?? '',
  isp: styles.toneIsp ?? '',
  internet: styles.toneInternet ?? '',
  datacenter: styles.toneDatacenter ?? '',
  remote: styles.toneRemote ?? '',
};

/** Zone lettering grows less than device names: it is decoration that must also stay clear of them. */
function zoneScale(labelScale: number): number {
  return Math.round((1 + (labelScale - 1) * 0.6) * 20) / 20;
}

interface LayerProps {
  model: SceneModel;
}

/** Faint isometric floor, one path, faded towards the edges by the mask in `SceneDefs`. */
export const GridLayer = memo(function GridLayer({ model }: LayerProps) {
  return (
    <g mask={urlRef(GRID_MASK_ID)} aria-hidden="true">
      <path className={styles.grid} d={model.gridPath} />
    </g>
  );
});

/** The labelled plates the devices stand on. */
export const ZoneLayer = memo(function ZoneLayer({ model }: LayerProps) {
  return (
    <g aria-hidden="true">
      {model.zones.map((zone) => (
        <g key={zone.def.id} className={TONE_CLASS[zone.tone]} data-zone={zone.def.id}>
          <path className={styles.plateSide} d={zone.side} />
          <polygon className={styles.plate} points={zone.points} />
          {zone.inset === '' ? null : <path className={styles.plateInset} d={zone.inset} />}
        </g>
      ))}
    </g>
  );
});

/**
 * Zone names, lettered on the floor along a plate edge. Drawn above the links; the model has already
 * picked a spot no link or device crosses. When there was none, the text gets a plate-coloured backing.
 */
export const ZoneLabelLayer = memo(function ZoneLabelLayer({
  model,
  labelScale,
}: LayerProps & { labelScale: number }) {
  const labels = useMemo(() => model.zoneLabels(zoneScale(labelScale)), [model, labelScale]);

  return (
    <g aria-hidden="true">
      {model.zones.map((zone, index) => {
        const label = labels[index];
        if (label === undefined) {
          return null;
        }

        return (
          <g
            key={zone.def.id}
            className={TONE_CLASS[zone.tone]}
            transform={label.matrix}
            data-zone-label={zone.def.id}
            data-backed={label.needsBacking ? 'true' : undefined}
          >
            {label.needsBacking ? (
              <rect
                className={styles.zoneLabelBack}
                x={label.backing.x}
                y={label.backing.y}
                width={label.backing.width}
                height={label.backing.height}
                rx={4}
              />
            ) : null}
            <text className={styles.zoneLabel} x={0} y={0} style={{ fontSize: label.fontSize }}>
              {label.text}
            </text>
          </g>
        );
      })}
    </g>
  );
});
