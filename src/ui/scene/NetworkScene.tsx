import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CompiledScenario } from '../../engine/compile';
import type { PlaybackState } from '../../engine/playback';
import { usePlayback } from '../../engine/store';
import { nodeKindInfo } from '../../protocols/nodeKinds';
import { PROTOCOLS } from '../../protocols/registry';
import { ActionLayer } from './ActionLayer';
import { LinkLayer } from './LinkLayer';
import { NodeLayer } from './NodeLayer';
import { PacketLayer } from './PacketLayer';
import { SceneDefs } from './SceneDefs';
import { MAX_LABEL_SCALE, sceneModelFor } from './sceneModel';
import type { SceneModel } from './sceneModel';
import { GridLayer, ZoneLabelLayer, ZoneLayer } from './ZoneLayer';
import styles from './scene.module.css';

/** Below this rendered scale the address lines are hidden (they stay in each device's `<title>`). */
const COMPACT_SCALE = 0.75;
/** Rendered text size, in px, that the label scale tries to keep the device names at. */
const NAME_TARGET_PX = 10.5;

const selectCompiled = (_s: PlaybackState, c: CompiledScenario): CompiledScenario => c;
const selectReduced = (s: PlaybackState): boolean => s.motion === 'reduced';

/**
 * The isometric network scene. Static layers (floor, plates, labels) are built once per scenario;
 * links, devices and actions re-render only when what they show changes; packets follow the clock.
 */
export function NetworkScene() {
  const compiled = usePlayback(selectCompiled);
  const reduced = usePlayback(selectReduced);
  const model = useMemo(() => sceneModelFor(compiled), [compiled]);

  const { ref, compact, labelScale } = useRenderedScale(model);

  const titleId = useId();
  const textId = useId();
  const { viewBox } = model;
  const viewBoxAttr = `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`;

  return (
    <div className={styles.root} ref={ref}>
      <svg
        className={styles.svg}
        viewBox={viewBoxAttr}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-labelledby={titleId}
        aria-describedby={textId}
        data-motion={reduced ? 'reduced' : 'full'}
        data-scenario={compiled.def.id}
      >
        <title id={titleId}>{`${compiled.def.title}: network diagram`}</title>
        <SceneDefs area={viewBox} />
        <GridLayer model={model} />
        <ZoneLayer model={model} />
        <LinkLayer model={model} compact={compact} />
        <ZoneLabelLayer model={model} labelScale={labelScale} />
        <NodeLayer model={model} compact={compact} labelScale={labelScale} />
        <ActionLayer model={model} compiled={compiled} labelScale={labelScale} />
      </svg>
      <PacketLayer
        model={model}
        viewBox={viewBoxAttr}
        compiled={compiled}
        labelScale={labelScale}
      />
      <SceneText id={textId} compiled={compiled} />
    </div>
  );
}

/**
 * Measures the rendered scale of the fitted viewBox with a ResizeObserver (never per frame) and derives
 * the two decisions that depend on it. Scale is rounded so a window drag re-renders rarely.
 */
function useRenderedScale(model: SceneModel) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const { width, height } = model.viewBox;

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box === undefined || box.width <= 0 || box.height <= 0) {
        return;
      }

      setScale(Math.round(Math.min(box.width / width, box.height / height) * 20) / 20);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [width, height]);

  const labelScale = Math.min(MAX_LABEL_SCALE, Math.max(1, NAME_TARGET_PX / (13 * scale)));

  return { ref, compact: scale < COMPACT_SCALE, labelScale: Math.round(labelScale * 20) / 20 };
}

/** Text alternative: the devices, and the packets of the current step. Hidden visually, read by assistive tech. */
const SceneText = memo(function SceneText({
  id,
  compiled,
}: {
  id: string;
  compiled: CompiledScenario;
}) {
  const stepIndex = usePlayback(selectStepIndex);
  const step = compiled.steps[stepIndex];

  const devices = compiled.def.nodes.map((node) => {
    const address = node.sublabel === undefined ? '' : `, ${node.sublabel}`;

    return `${node.label} (${nodeKindInfo(node.kind).label}${address})`;
  });

  const nameOf = (nodeId: string): string => compiled.nodeById.get(nodeId)?.label ?? nodeId;

  return (
    <div id={id} className={styles.srOnly}>
      <p>{`Devices: ${devices.join('; ')}.`}</p>
      {step === undefined ? null : (
        <>
          <p>{`Step ${stepIndex + 1} of ${compiled.steps.length}: ${step.def.title}.`}</p>
          <ul>
            {step.packetIndices.map((index) => {
              const packet = compiled.packets[index];
              if (packet === undefined) {
                return null;
              }

              const { def } = packet;
              const route = [def.from, ...(def.via ?? []), def.to].map(nameOf).join(', then ');

              return (
                <li key={def.id}>
                  {`${PROTOCOLS[def.protocol].label} packet ${def.label}: ${route}.${outcomeText(def.outcome?.kind)}`}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
});

const selectStepIndex = (s: PlaybackState): number => s.stepIndex;

function outcomeText(kind: string | undefined): string {
  switch (kind) {
    case 'lost':
      return ' It is lost on the way.';
    case 'dropped':
      return ' It is dropped.';
    case 'blocked':
      return ' It arrives but the browser blocks it.';
    default:
      return '';
  }
}
