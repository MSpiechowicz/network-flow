import { memo } from 'react';
import type { KeyboardEvent } from 'react';
import type { ActivePacket } from '../../engine/selectors';
import { PROTOCOLS } from '../../protocols/registry';
import type { ProtocolId } from '../../protocols/registry';
import { pktGradientId, urlRef } from './devices/ids';
import { glyphMode, placePacket } from './packetMotion';
import type { GlyphMode } from './packetMotion';
import type { SceneModel } from './sceneModel';
import styles from './scene.module.css';
import { textWidth } from './textWidth';

const CHIP_HEIGHT = 22;
/** Bottom of the label chip, above the dot. */
const CHIP_BOTTOM = -20;
const CHAR_WIDTH = 7;

interface PacketGlyphProps {
  item: ActivePacket;
  model: SceneModel;
  timeMs: number;
  reduced: boolean;
  /** Glyph size factor: grows when the whole scene is shrunk to fit a small panel. */
  labelScale: number;
  selected: boolean;
  /** Accessible name, e.g. "SYN, from Your laptop to Web server". */
  name: string;
  onSelect: (packetId: string) => void;
}

/**
 * One packet (or one broadcast copy). The outer group carries the per-frame `transform` and `opacity`;
 * the artwork inside only re-renders when the packet's outcome state or selection changes.
 */
export function PacketGlyph({
  item,
  model,
  timeMs,
  reduced,
  labelScale,
  selected,
  name,
  onSelect,
}: PacketGlyphProps) {
  const { def } = item.packet;
  const place = placePacket(item, model, timeMs, reduced);

  const select = (): void => {
    onSelect(def.id);
  };
  const onKeyDown = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  };

  return (
    <g
      className={styles.packet}
      data-packet={def.id}
      data-copy={item.copy}
      data-phase={item.phase}
      transform={`translate(${place.x.toFixed(2)} ${place.y.toFixed(2)}) scale(${(labelScale * place.grow).toFixed(3)})`}
      opacity={place.opacity < 1 ? place.opacity.toFixed(3) : undefined}
      role="button"
      tabIndex={0}
      aria-label={name}
      aria-pressed={selected}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      <PacketBody
        protocol={def.protocol}
        label={def.label}
        encrypted={def.encrypted === true}
        mode={glyphMode(item)}
        selected={selected}
      />
    </g>
  );
}

interface PacketBodyProps {
  protocol: ProtocolId;
  label: string;
  encrypted: boolean;
  mode: GlyphMode;
  selected: boolean;
}

const BURST_RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

const PacketBody = memo(function PacketBody({
  protocol,
  label,
  encrypted,
  mode,
  selected,
}: PacketBodyProps) {
  const color = PROTOCOLS[protocol].color;
  const chipWidth = Math.round(
    textWidth(label, 700, 11.5, 'mono', CHAR_WIDTH) + 18 + (encrypted ? 13 : 0),
  );
  const chipX = -chipWidth / 2;
  const chipY = CHIP_BOTTOM - CHIP_HEIGHT;
  const textX = encrypted ? 6 : 0;

  return (
    <>
      <circle className={styles.hit} r={17} />

      {mode === 'flying' ? (
        <g className={styles.noEvents}>
          <circle r={24} fill={urlRef(pktGradientId(protocol))} />
          <circle r={5.6} fill={color} />
          <circle r={2.6} fill="#fff" />
          {selected ? <circle className={styles.selected} r={10} strokeDasharray="3 3" /> : null}
        </g>
      ) : null}

      {mode === 'lost' ? (
        <g className={styles.noEvents}>
          {BURST_RAYS.map((angle) => (
            <path
              key={angle}
              className={styles.burst}
              d="M0 -7V-13"
              transform={`rotate(${angle})`}
              style={{ animationDelay: `${(angle % 90) / 1000}s` }}
            />
          ))}
          <g className={styles.badge}>
            <circle className={styles.lostHalo} r={13} />
            <path className={styles.badgeGlyph} d="M-6-6L6 6M6-6L-6 6" />
          </g>
        </g>
      ) : null}

      {mode === 'dropped' ? (
        <g className={`${styles.noEvents} ${styles.badge}`}>
          <circle className={styles.badgeBack} r={10.5} />
          <path className={styles.badgeGlyph} d="M-4-4L4 4M4-4L-4 4" />
        </g>
      ) : null}

      {mode === 'blocked' ? (
        <g className={`${styles.noEvents} ${styles.badge}`}>
          <path
            className={styles.badgeBack}
            d="M0-11.5L9 -8V-1.5C9 4.5 5 8 0 10.5-5 8-9 4.5-9-1.5V-8Z"
          />
          <path className={styles.badgeGlyph} d="M-3.4-3.4L3.4 3.4M3.4-3.4L-3.4 3.4" />
        </g>
      ) : null}

      <g
        className={`${styles.noEvents} ${mode === 'flying' || mode === 'blocked' ? '' : styles.chipFaded}`}
      >
        <line
          className={styles.stem}
          y1={mode === 'flying' ? -7 : -12}
          y2={CHIP_BOTTOM}
          stroke={color}
        />
        <rect
          x={chipX}
          y={chipY}
          width={chipWidth}
          height={CHIP_HEIGHT}
          rx={CHIP_HEIGHT / 2}
          fill={color}
        />
        {selected ? (
          <rect
            className={styles.selected}
            x={chipX - 3}
            y={chipY - 3}
            width={chipWidth + 6}
            height={CHIP_HEIGHT + 6}
            rx={CHIP_HEIGHT / 2 + 3}
          />
        ) : null}
        {encrypted ? (
          <g transform={`translate(${chipX + 11} ${chipY + 10.6})`}>
            <rect className={styles.chipLockBody} x={-3.6} y={0} width={7.2} height={5.6} rx={1} />
            <path className={styles.chipLock} d="M-2.2 0V-1.6a2.2 2.2 0 0 1 4.4 0V0" />
          </g>
        ) : null}
        <text className={styles.chipText} x={textX} y={chipY + 15}>
          {label}
        </text>
      </g>

      <rect
        className={styles.focusRing}
        x={chipX - 4}
        y={chipY - 4}
        width={chipWidth + 8}
        height={CHIP_HEIGHT + 8}
        rx={CHIP_HEIGHT / 2 + 4}
      />
    </>
  );
});
