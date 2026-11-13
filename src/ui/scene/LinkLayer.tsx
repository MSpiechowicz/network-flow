import { memo, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { usePlayback } from '../../engine/store';
import type { CompiledScenario } from '../../engine/compile';
import type { PlaybackState } from '../../engine/playback';
import { PROTOCOLS } from '../../protocols/registry';
import type { ProtocolId } from '../../protocols/registry';
import { parseLinkHighlight, sameStrings, selectLinkHighlights } from './sceneFrame';
import type { SceneLink, SceneModel } from './sceneModel';
import styles from './scene.module.css';

const selectHighlights = (s: PlaybackState, c: CompiledScenario): string[] =>
  selectLinkHighlights(c, s.timeMs, s.motion === 'reduced');

interface LinkLayerProps {
  model: SceneModel;
  compact: boolean;
}

/**
 * The cables between devices. A link that carries a packet changes itself: it takes the protocol colour
 * and its dashes flow in the direction of travel. There is no second line on top of it.
 */
export const LinkLayer = memo(function LinkLayer({ model, compact }: LinkLayerProps) {
  const keys = usePlayback(selectHighlights, sameStrings);

  const byLink = useMemo(() => {
    const map = new Map<string, string>();
    for (const key of keys) {
      map.set(parseLinkHighlight(key).linkId, key);
    }

    return map;
  }, [keys]);

  return (
    <g aria-hidden="true">
      {model.links.map((link) => (
        <LinkView
          key={link.def.id}
          link={link}
          highlight={byLink.get(link.def.id)}
          compact={compact}
        />
      ))}
    </g>
  );
});

interface LinkViewProps {
  link: SceneLink;
  /** Key from `selectLinkHighlights`, or `undefined` for an idle link. */
  highlight: string | undefined;
  compact: boolean;
}

const LinkView = memo(function LinkView({ link, highlight, compact }: LinkViewProps) {
  const parsed = highlight === undefined ? null : parseLinkHighlight(highlight);
  const protocol = parsed !== null && parsed.protocol in PROTOCOLS ? parsed.protocol : null;
  const hue = protocol === null ? undefined : PROTOCOLS[protocol as ProtocolId].color;
  const state = parsed?.state;

  return (
    <g
      data-link={link.def.id}
      data-state={state}
      style={hue === undefined ? undefined : ({ '--hue': hue } as CSSProperties)}
    >
      <path className={styles.bed} d={link.d} data-state={state} />
      <path
        className={styles.link}
        d={link.d}
        data-medium={link.def.medium}
        data-state={state}
        data-direction={parsed?.direction}
      />
      {link.label !== null && !compact ? (
        <text
          className={styles.linkLabel}
          transform={`translate(${link.label.x} ${link.label.y}) rotate(${link.label.angle})`}
          y={-7}
        >
          {link.def.label}
        </text>
      ) : null}
    </g>
  );
});
