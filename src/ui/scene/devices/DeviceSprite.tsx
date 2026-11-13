import { nodeKindInfo } from '../../../protocols/nodeKinds';
import type { NodeKind, SpriteId } from '../../../protocols/nodeKinds';
import { kindBounds } from './kindBounds';
import { RACK_SHAPES } from './rackShape';
import { ServerRack } from './ServerRack';
import { SPRITES } from './sprites';
import { KIND_TINT } from './tints';

export interface DeviceSpriteProps {
  kind: NodeKind;
  active?: boolean;
}

const BADGE_HEIGHT = 16;
const BADGE_GAP = 8;
const CHAR_WIDTH = 6.4;

/** Small floating label chip (ROOT, TLD, ...) centred above the device. 3 elements. */
function BadgeChip({ label, tint, top }: { label: string; tint: string; top: number }) {
  const width = Math.round(label.length * CHAR_WIDTH + 14);
  const y = -(top + BADGE_GAP + BADGE_HEIGHT);

  return (
    <g>
      <path
        d={`M-3 ${y + BADGE_HEIGHT}L0 ${y + BADGE_HEIGHT + 4}L3 ${y + BADGE_HEIGHT}Z`}
        style={{ fill: tint }}
      />
      <rect
        x={-width / 2}
        y={y}
        width={width}
        height={BADGE_HEIGHT}
        rx={BADGE_HEIGHT / 2}
        style={{ fill: 'var(--panel-2)', stroke: tint, strokeWidth: 1.2 }}
      />
      <text
        x={0}
        y={y + 11.2}
        textAnchor="middle"
        style={{
          fill: tint,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </text>
    </g>
  );
}

/**
 * Draws the device for a node kind around the local origin (centre of its base on the ground):
 * the kind's sprite in the kind's tint, plus its badge chip floating above when it has one.
 */
export function DeviceSprite({ kind, active = false }: DeviceSpriteProps) {
  const info = nodeKindInfo(kind);
  const tint = KIND_TINT[kind];
  const { top } = kindBounds(kind);

  return (
    <g aria-hidden="true">
      {info.sprite === 'server' ? (
        <ServerRack tint={tint} active={active} {...RACK_SHAPES[kind]} />
      ) : (
        <SpriteComponent sprite={info.sprite} tint={tint} active={active} />
      )}
      {info.badge ? <BadgeChip label={info.badge} tint={tint} top={top} /> : null}
    </g>
  );
}

function SpriteComponent({
  sprite,
  tint,
  active,
}: {
  sprite: SpriteId;
  tint: string;
  active: boolean;
}) {
  const { Component } = SPRITES[sprite];

  return <Component tint={tint} active={active} />;
}
