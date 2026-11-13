import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, RefObject } from 'react';
import type { CompiledPacket, CompiledScenario } from '../../engine/compile';
import type { PlaybackState } from '../../engine/playback';
import { usePlayback, usePlaybackDispatch } from '../../engine/store';
import { nodeKindInfo } from '../../protocols/nodeKinds';
import { PROTOCOLS } from '../../protocols/registry';
import { ACTION_ICON, ACTION_TINT } from '../scene/actionGlyphs';
import { KIND_TINT } from '../scene/devices';
import { BAND_TITLE_HEIGHT, layoutSequence, sequenceLaneIds } from './sequenceLayout';
import type { SequenceLayout } from './sequenceLayout';
import styles from './sequence.module.css';
import { textWidth } from '../scene/textWidth';

const HEADER_HEIGHT = 68;
const MIN_LANE_GAP = 156;
const MAX_LANE_GAP = 340;
/** After the user scrolls by hand, the view stops following the playhead for this long. */
const MANUAL_SCROLL_PAUSE_MS = 3000;
const CHAR_WIDTH = 6.9;
const PILL_HEIGHT = 20;

const selectCompiled = (_s: PlaybackState, c: CompiledScenario): CompiledScenario => c;
const selectSelected = (s: PlaybackState): string | null => s.selectedPacketId;
const selectMotion = (s: PlaybackState): 'full' | 'reduced' => s.motion;

/** The same moment as the network scene, drawn as a sequence diagram. */
export function SequenceView() {
  const compiled = usePlayback(selectCompiled);
  const motion = usePlayback(selectMotion);
  const dispatch = usePlaybackDispatch();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const manualScrollAt = useRef(-Infinity);
  useManualScrollNotice(scrollerRef, manualScrollAt);
  const width = useClientWidth(scrollerRef);

  const laneCount = useMemo(() => sequenceLaneIds(compiled).length, [compiled]);
  const laneGap = Math.min(
    MAX_LANE_GAP,
    Math.max(MIN_LANE_GAP, Math.floor((width - 8) / Math.max(1, laneCount))),
  );
  const contentWidth = Math.max(width, laneGap * laneCount);
  const padLeft = Math.max(0, (contentWidth - laneGap * laneCount) / 2);

  const layout = useMemo(
    () => layoutSequence(compiled, { laneGap, padLeft }),
    [compiled, laneGap, padLeft],
  );

  const select = useCallback(
    (packetId: string): void => {
      // Choosing an arrow is a deliberate jump: follow the playhead again at once.
      manualScrollAt.current = -Infinity;
      dispatch({ type: 'selectPacket', packetId, seek: true });
    },
    [dispatch],
  );

  return (
    <div
      ref={scrollerRef}
      className={styles.scroller}
      data-motion={motion}
      // A scrollable region must be reachable by keyboard: arrow keys scroll it once it has focus.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="region"
      aria-label={`Sequence diagram: ${compiled.def.title}`}
    >
      <div className={styles.content} style={{ width: contentWidth }}>
        <LaneHeaders compiled={compiled} layout={layout} />
        <svg
          className={styles.svg}
          width={contentWidth}
          height={layout.height}
          viewBox={`0 0 ${contentWidth} ${layout.height}`}
          role="group"
          aria-label="Packets between devices, in time order from top to bottom"
        >
          <BandLayer compiled={compiled} layout={layout} width={contentWidth} />
          <LifelineLayer compiled={compiled} layout={layout} />
          <ActionBars compiled={compiled} layout={layout} width={contentWidth} />
          <ArrowLayer compiled={compiled} layout={layout} onSelect={select} />
          <PlayheadLayer compiled={compiled} layout={layout} width={contentWidth} />
        </svg>
      </div>
      <AutoScroll scrollerRef={scrollerRef} layout={layout} manualScrollAt={manualScrollAt} />
    </div>
  );
}

/** Remembers when the user last scrolled by hand (wheel, touch, scrollbar drag or keys). */
function useManualScrollNotice(
  ref: RefObject<HTMLDivElement | null>,
  manualScrollAt: RefObject<number>,
): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }

    const note = (): void => {
      manualScrollAt.current = performance.now();
    };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

    for (const name of events) {
      element.addEventListener(name, note, { passive: true });
    }

    return () => {
      for (const name of events) {
        element.removeEventListener(name, note);
      }
    };
  }, [ref, manualScrollAt]);
}

/** Width of the scroll container, measured when it resizes. */
function useClientWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      setWidth(Math.max(240, element.clientWidth));
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return width;
}

/* ----------------------------------------------------------------- headers */

const LaneHeaders = memo(function LaneHeaders({
  compiled,
  layout,
}: {
  compiled: CompiledScenario;
  layout: SequenceLayout;
}) {
  const gap = layout.lanes.length > 1 ? (layout.lanes[1]?.x ?? 0) - (layout.lanes[0]?.x ?? 0) : 150;

  return (
    <div className={styles.header}>
      {layout.lanes.map((lane) => {
        const node = compiled.nodeById.get(lane.nodeId);
        if (node === undefined) {
          return null;
        }

        return (
          <div
            key={lane.nodeId}
            className={styles.lane}
            data-lane={lane.nodeId}
            style={
              {
                '--tint': KIND_TINT[node.kind],
                left: lane.x - gap / 2 + 5,
                width: gap - 10,
              } as CSSProperties
            }
            title={[node.label, node.sublabel].filter(Boolean).join(' - ')}
          >
            <span className={styles.laneName}>{lane.label}</span>
            <span className={styles.laneKind}>
              <span className={styles.laneKindText}>{nodeKindInfo(node.kind).label}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
});

/* ------------------------------------------------------------------- bands */

const BandLayer = memo(function BandLayer({
  compiled,
  layout,
  width,
}: {
  compiled: CompiledScenario;
  layout: SequenceLayout;
  width: number;
}) {
  const phaseLabels = useMemo(
    () => new Map((compiled.def.phases ?? []).map((phase) => [phase.id, phase.label])),
    [compiled],
  );

  return (
    <g>
      {layout.stepBands.map((band) => {
        const step = compiled.steps[band.stepIndex];
        if (step === undefined) {
          return null;
        }

        const phase = step.def.phase === undefined ? undefined : phaseLabels.get(step.def.phase);

        return (
          <g key={band.stepIndex} data-step-band={band.stepIndex}>
            <rect
              className={styles.band}
              data-odd={band.stepIndex % 2 === 1}
              x={0}
              y={band.y0}
              width={width}
              height={band.y1 - band.y0}
            />
            <rect
              className={styles.bandHead}
              x={0}
              y={band.y0}
              width={width}
              height={BAND_TITLE_HEIGHT - 4}
            />
            <line className={styles.bandLine} x1={0} x2={width} y1={band.y0} y2={band.y0} />
            <circle className={styles.bandBadge} cx={24} cy={band.y0 + 13} r={9} />
            <text className={styles.bandNum} x={24} y={band.y0 + 16.8}>
              {band.stepIndex + 1}
            </text>
            <text className={styles.bandTitle} x={42} y={band.y0 + 17.5}>
              <tspan>{step.def.title}</tspan>
              {phase === undefined ? null : (
                <tspan className={styles.bandPhase} dx={12}>
                  {phase}
                </tspan>
              )}
            </text>
          </g>
        );
      })}
    </g>
  );
});

const LifelineLayer = memo(function LifelineLayer({
  compiled,
  layout,
}: {
  compiled: CompiledScenario;
  layout: SequenceLayout;
}) {
  return (
    <g aria-hidden="true">
      {layout.lanes.map((lane) => {
        const node = compiled.nodeById.get(lane.nodeId);

        return (
          <line
            key={lane.nodeId}
            className={styles.lifeline}
            style={
              { '--tint': node === undefined ? undefined : KIND_TINT[node.kind] } as CSSProperties
            }
            x1={lane.x}
            x2={lane.x}
            y1={0}
            y2={layout.height}
          />
        );
      })}
    </g>
  );
});

/* ----------------------------------------------------------------- actions */

const ActionBars = memo(function ActionBars({
  compiled,
  layout,
  width,
}: {
  compiled: CompiledScenario;
  layout: SequenceLayout;
  width: number;
}) {
  return (
    <g aria-hidden="true">
      {layout.actions.map((placed) => {
        const action = compiled.actions[placed.actionIndex];
        if (action === undefined) {
          return null;
        }

        const kind = action.def.kind;
        const labelWidth = action.def.label.length * 6.4 + 26;
        // Labels sit beside the bar, on the side that has room.
        const flip = placed.x + 12 + labelWidth > width;
        const midY = (placed.y0 + placed.y1) / 2;

        return (
          <g
            key={action.def.id}
            data-action={action.def.id}
            style={{ '--tint': ACTION_TINT[kind] } as CSSProperties}
          >
            <rect
              className={styles.actionBar}
              x={placed.x - 5}
              y={placed.y0}
              width={10}
              height={placed.y1 - placed.y0}
              rx={3}
            />
            <g
              className={styles.actionIcon}
              transform={`translate(${flip ? placed.x - 18 : placed.x + 18} ${midY})`}
            >
              {ACTION_ICON[kind]}
            </g>
            <text
              className={styles.actionLabel}
              x={flip ? placed.x - 28 : placed.x + 28}
              y={midY + 4}
              textAnchor={flip ? 'end' : 'start'}
            >
              {action.def.label}
            </text>
          </g>
        );
      })}
    </g>
  );
});

/* ------------------------------------------------------------------ arrows */

const ArrowLayer = memo(function ArrowLayer({
  compiled,
  layout,
  onSelect,
}: {
  compiled: CompiledScenario;
  layout: SequenceLayout;
  onSelect: (packetId: string) => void;
}) {
  const selectedId = usePlayback(selectSelected);

  const laneX = useMemo(() => new Map(layout.lanes.map((lane) => [lane.nodeId, lane.x])), [layout]);

  // Arrows of one step between the same two lanes run side by side; spread their labels along
  // the arrows so the pills do not stack on top of each other.
  const labelAt = useMemo(() => {
    const groups = new Map<string, number[]>();
    layout.arrows.forEach((arrow, index) => {
      const step = compiled.packets[arrow.packetIndex]?.stepIndex ?? -1;
      const key = `${String(step)}|${String(arrow.x1)}|${String(arrow.x2)}`;
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });

    const at = new Map<number, number>();
    for (const members of groups.values()) {
      members.forEach((index, k) => {
        at.set(index, members.length === 1 ? 0.5 : 0.2 + (0.6 * k) / (members.length - 1));
      });
    }

    return at;
  }, [compiled, layout]);

  return (
    <g>
      {layout.arrows.map((arrow, arrowIndex) => {
        const packet = compiled.packets[arrow.packetIndex];
        if (packet === undefined) {
          return null;
        }

        const from = compiled.nodeById.get(packet.def.from)?.label ?? packet.def.from;
        const to = compiled.nodeById.get(packet.def.to)?.label ?? packet.def.to;

        return (
          <g key={packet.def.id}>
            <FloodArrows packet={packet} arrow={arrow} laneX={laneX} layout={layout} />
            <ArrowView
              arrow={arrow}
              packet={packet}
              labelAt={labelAt.get(arrowIndex) ?? 0.5}
              layer="line"
              selected={packet.def.id === selectedId}
              name={`${packet.def.label}, from ${from} to ${to}`}
              onSelect={onSelect}
            />
          </g>
        );
      })}
      {layout.arrows.map((arrow, arrowIndex) => {
        const packet = compiled.packets[arrow.packetIndex];
        if (packet === undefined) {
          return null;
        }

        return (
          <ArrowView
            key={`label-${packet.def.id}`}
            arrow={arrow}
            packet={packet}
            labelAt={labelAt.get(arrowIndex) ?? 0.5}
            layer="label"
            selected={packet.def.id === selectedId}
            name=""
            onSelect={onSelect}
          />
        );
      })}
    </g>
  );
});

interface ArrowViewProps {
  arrow: SequenceLayout['arrows'][number];
  packet: CompiledPacket;
  /** Where along the arrow its label sits, 0 (tail) to 1 (head). */
  labelAt: number;
  /** `line` draws the arrow itself; `label` draws only its pill, in a pass above all arrows. */
  layer: 'line' | 'label';
  selected: boolean;
  name: string;
  onSelect: (packetId: string) => void;
}

const ArrowView = memo(function ArrowView({
  arrow,
  packet,
  labelAt,
  layer,
  selected,
  name,
  onSelect,
}: ArrowViewProps) {
  const { def } = packet;
  const { x1, y1, x2, y2, endKind } = arrow;
  const encrypted = def.encrypted === true;

  const onKeyDown = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(def.id);
    }
  };

  const sameLane = Math.abs(x2 - x1) < 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const angle = sameLane ? 180 : (Math.atan2(dy, dx) * 180) / Math.PI;

  const stops = endKind === 'lost' || endKind === 'dropped';
  const hasHead = !stops;
  // The tip of the arrowhead stops short of the lane when a shield sits on it.
  const tipBack = endKind === 'blocked' ? 12 : 0;
  const tipX = x2 - ux * tipBack;
  const tipY = y2 - uy * tipBack;
  const shaftEndX = hasHead ? tipX - ux * 7 : x2;
  const shaftEndY = hasHead ? tipY - uy * 7 : y2;

  const shaft = sameLane
    ? `M${x1} ${y1}C${x1 + 46} ${y1} ${x1 + 46} ${y2} ${x1 + 8} ${y2}`
    : `M${x1} ${y1}L${shaftEndX} ${shaftEndY}`;

  const pillWidth = Math.round(
    textWidth(def.label, 700, 11.5, 'mono', CHAR_WIDTH) + 18 + (encrypted ? 13 : 0),
  );
  const labelX = sameLane ? x1 + 50 + pillWidth / 2 : x1 + (x2 - x1) * labelAt;
  const labelY = sameLane ? (y1 + y2) / 2 : y1 + (y2 - y1) * labelAt;

  if (layer === 'label') {
    // Drawn in a second pass, above every arrow, so no shaft crosses a pill.
    return (
      <g
        className={styles.arrowLabelLayer}
        data-selected={selected}
        style={{ '--hue': PROTOCOLS[def.protocol].color } as CSSProperties}
        aria-hidden="true"
      >
        <g transform={`translate(${labelX} ${labelY})`}>
          <rect
            className={styles.arrowPill}
            x={-pillWidth / 2}
            y={-PILL_HEIGHT / 2}
            width={pillWidth}
            height={PILL_HEIGHT}
            rx={PILL_HEIGHT / 2}
          />
          {encrypted ? (
            <g transform={`translate(${-pillWidth / 2 + 11} -1.3)`}>
              <rect
                className={styles.arrowLockBody}
                x={-3.6}
                y={0}
                width={7.2}
                height={5.6}
                rx={1}
              />
              <path className={styles.arrowLock} d="M-2.2 0V-1.6a2.2 2.2 0 0 1 4.4 0V0" />
            </g>
          ) : null}
          <text className={styles.arrowLabel} x={encrypted ? 6 : 0} y={4}>
            {def.label}
          </text>
        </g>
      </g>
    );
  }

  return (
    <g
      className={styles.arrow}
      data-packet={def.id}
      data-selected={selected}
      data-end={endKind}
      style={{ '--hue': PROTOCOLS[def.protocol].color } as CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={name}
      aria-pressed={selected}
      onClick={() => {
        onSelect(def.id);
      }}
      onKeyDown={onKeyDown}
    >
      <title>{def.summary}</title>
      <path className={styles.arrowGlow} d={shaft} />
      <path className={styles.arrowHit} d={shaft} />
      <path
        className={styles.arrowShaft}
        d={shaft}
        strokeDasharray={encrypted ? '7 4' : undefined}
      />

      {hasHead ? (
        <path
          className={styles.arrowHead}
          d="M0 0L-9 -4.6L-9 4.6Z"
          transform={`translate(${sameLane ? x1 + 8 : tipX} ${sameLane ? y2 : tipY}) rotate(${angle})`}
        />
      ) : null}

      {endKind === 'lost' ? (
        <path
          className={styles.endGlyph}
          transform={`translate(${x2} ${y2})`}
          d="M-5-5L5 5M5-5L-5 5"
        />
      ) : null}

      {endKind === 'dropped' ? (
        <g transform={`translate(${x2} ${y2})`}>
          <circle className={styles.endBack} r={9} />
          <path className={styles.endGlyph} d="M-3.5-3.5L3.5 3.5M3.5-3.5L-3.5 3.5" />
        </g>
      ) : null}

      {endKind === 'blocked' ? (
        <g transform={`translate(${x2} ${y2})`}>
          <path className={styles.endBack} d="M0-10L8-7V-1C8 4 4.5 7.5 0 9.5-4.5 7.5-8 4-8-1V-7Z" />
          <path className={styles.endGlyph} d="M-3-3L3 3M3-3L-3 3" />
        </g>
      ) : null}
    </g>
  );
});

/** Broadcast copies: thin dotted arrows from the receiver to each neighbour that has a lane. */
const FloodArrows = memo(function FloodArrows({
  packet,
  arrow,
  laneX,
  layout,
}: {
  packet: CompiledPacket;
  arrow: SequenceLayout['arrows'][number];
  laneX: ReadonlyMap<string, number>;
  layout: SequenceLayout;
}) {
  if (packet.floodHops.length === 0) {
    return null;
  }

  return (
    <g
      aria-hidden="true"
      style={{ '--hue': PROTOCOLS[packet.def.protocol].color } as CSSProperties}
    >
      {packet.floodHops.map((hop) => {
        // Copies leave the receiver; when that is a device without a lane they leave from the sender's.
        const x1 = laneX.get(hop.from) ?? arrow.x1;
        const x2 = laneX.get(hop.to);
        // The copy the main arrow already stands for needs no second line.
        if (x2 === undefined || x1 === x2 || (x1 === arrow.x1 && x2 === arrow.x2)) {
          return null;
        }

        const y1 = layout.timeToY(hop.startMs);
        const y2 = Math.max(layout.timeToY(hop.endMs), y1 + 14);
        const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;

        return (
          <g key={`${hop.linkId}-${hop.to}`}>
            <line className={styles.flood} x1={x1} y1={y1} x2={x2} y2={y2} />
            <path
              className={styles.floodHead}
              d="M0 0L-8 -4L-8 4Z"
              transform={`translate(${x2} ${y2}) rotate(${angle})`}
            />
          </g>
        );
      })}
    </g>
  );
});

/* ---------------------------------------------------------------- playhead */

/** The y of the playhead: inside the current step, even when the clock sits exactly on its end. */
function playheadY(
  layout: SequenceLayout,
  c: CompiledScenario,
  stepIndex: number,
  timeMs: number,
): number {
  const step = c.steps[stepIndex];
  if (step === undefined) {
    return 0;
  }

  return layout.playheadY(Math.min(Math.max(timeMs, step.startMs), step.endMs - 0.001));
}

const PlayheadLayer = memo(function PlayheadLayer({
  compiled,
  layout,
  width,
}: {
  compiled: CompiledScenario;
  layout: SequenceLayout;
  width: number;
}) {
  const timeMs = usePlayback(selectTime);
  const stepIndex = usePlayback(selectStepIndex);
  const y = playheadY(layout, compiled, stepIndex, timeMs);
  const band = layout.stepBands[stepIndex];

  // Packets under way: a dot rides each arrow, exactly at the playhead's height.
  const travelling = compiled.packets.filter((packet) => {
    const last = packet.hops[packet.hops.length - 1];

    return last !== undefined && packet.startMs <= timeMs && timeMs <= last.endMs;
  });

  return (
    <g aria-hidden="true">
      {band === undefined ? null : (
        <>
          <rect
            className={styles.current}
            x={0}
            y={band.y0}
            width={width}
            height={band.y1 - band.y0}
          />
          <rect
            className={styles.currentBar}
            x={0}
            y={band.y0}
            width={3}
            height={band.y1 - band.y0}
          />
        </>
      )}
      <rect
        className={styles.future}
        x={0}
        y={y}
        width={width}
        height={Math.max(0, layout.height - y)}
      />
      <line className={styles.playhead} x1={0} x2={width} y1={y} y2={y} />
      <path className={styles.playheadMark} d="M0 -5L9 0L0 5Z" transform={`translate(0 ${y})`} />
      {travelling.map((packet) => {
        const arrow = layout.arrows[packet.index];
        const last = packet.hops[packet.hops.length - 1];
        if (arrow === undefined || last === undefined) {
          return null;
        }

        const span = last.endMs - packet.startMs;
        const f = span > 0 ? Math.min(1, Math.max(0, (timeMs - packet.startMs) / span)) : 1;

        return (
          <g
            key={packet.def.id}
            transform={`translate(${arrow.x1 + (arrow.x2 - arrow.x1) * f} ${arrow.y1 + (arrow.y2 - arrow.y1) * f})`}
            style={{ '--hue': PROTOCOLS[packet.def.protocol].color } as CSSProperties}
          >
            <circle className={styles.dotGlow} r={10} />
            <circle className={styles.dotCore} r={4.6} />
          </g>
        );
      })}
    </g>
  );
});

const selectTime = (s: PlaybackState): number => s.timeMs;
const selectStepIndex = (s: PlaybackState): number => s.stepIndex;

/**
 * Keeps the playhead on screen by setting `scrollTop` on the container. It stays out of the way for
 * three seconds after the user has scrolled, and never uses `scrollIntoView`.
 */
function AutoScroll({
  scrollerRef,
  layout,
  manualScrollAt,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  layout: SequenceLayout;
  manualScrollAt: RefObject<number>;
}) {
  const select = useCallback(
    (s: PlaybackState, c: CompiledScenario): number =>
      Math.round(playheadY(layout, c, s.stepIndex, s.timeMs)),
    [layout],
  );
  const y = usePlayback(select);
  const placed = useRef(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || performance.now() - manualScrollAt.current < MANUAL_SCROLL_PAUSE_MS) {
      return;
    }

    const absolute = HEADER_HEIGHT + y;
    const viewTop = scroller.scrollTop + HEADER_HEIGHT + 36;
    const viewBottom = scroller.scrollTop + scroller.clientHeight - 56;

    if (absolute >= viewTop && absolute <= viewBottom) {
      placed.current = true;

      return;
    }

    const target = Math.max(0, absolute - scroller.clientHeight * 0.4);

    if (!placed.current) {
      // First placement after mounting: jump, do not glide from the top.
      scroller.style.scrollBehavior = 'auto';
      scroller.scrollTop = target;
      scroller.style.scrollBehavior = '';
      placed.current = true;

      return;
    }

    scroller.scrollTop = target;
  }, [y, scrollerRef, manualScrollAt]);

  return null;
}
