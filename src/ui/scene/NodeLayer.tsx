import { memo, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { usePlayback } from '../../engine/store';
import type { CompiledScenario } from '../../engine/compile';
import type { PlaybackState } from '../../engine/playback';
import { nodeKindInfo } from '../../protocols/nodeKinds';
import { DeviceSprite } from './devices';
import { nodeHighlightMap, sameStrings, selectNodeHighlights } from './sceneFrame';
import type { NodeHighlight } from './sceneFrame';
import { labelBaseline } from './sceneModel';
import type { SceneModel, SceneNode } from './sceneModel';
import styles from './scene.module.css';

const selectHighlights = (s: PlaybackState, c: CompiledScenario): string[] =>
  selectNodeHighlights(c, s.stepIndex, s.timeMs);

interface NodeLayerProps {
  model: SceneModel;
  /** Hide the address line: the scene is rendered too small for it to stay legible. */
  compact: boolean;
  /** Grows label text in scene units when the whole scene is shrunk to fit a small panel. */
  labelScale: number;
}

/** Devices, back to front, with their name and address. Re-renders only when the highlight set changes. */
export const NodeLayer = memo(function NodeLayer({ model, compact, labelScale }: NodeLayerProps) {
  const keys = usePlayback(selectHighlights, sameStrings);
  const highlights = useMemo(() => nodeHighlightMap(keys), [keys]);

  return (
    <g>
      {model.nodesByDepth.map((node) => (
        <NodeView
          key={node.def.id}
          node={node}
          state={highlights.get(node.def.id)}
          compact={compact}
          labelScale={labelScale}
        />
      ))}
    </g>
  );
});

interface NodeViewProps {
  node: SceneNode;
  state: NodeHighlight | undefined;
  compact: boolean;
  labelScale: number;
}

const NodeView = memo(function NodeView({ node, state, compact, labelScale }: NodeViewProps) {
  const { def } = node;
  const kind = nodeKindInfo(def.kind);
  const title = [def.label, def.sublabel, kind.label].filter(Boolean).join(' - ');

  const labelY = labelBaseline(node, labelScale);

  return (
    <g
      className={styles.node}
      data-node={def.id}
      data-kind={def.kind}
      data-state={state}
      transform={`translate(${node.x} ${node.y})`}
      style={{ '--tint': node.tint } as CSSProperties}
    >
      <title>{title}</title>
      <ellipse className={styles.ring} rx={node.ringRx} ry={node.ringRy} />
      <DeviceSprite kind={def.kind} active={state === 'active'} />
      <g transform={`translate(0 ${labelY}) scale(${labelScale})`}>
        <text className={styles.name} y={0}>
          {def.label}
        </text>
        {def.sublabel !== undefined && !compact ? (
          <text className={styles.sub} y={node.subY - node.nameY}>
            {def.sublabel}
          </text>
        ) : null}
      </g>
    </g>
  );
});
