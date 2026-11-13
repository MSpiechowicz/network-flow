import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import type { CompiledPacket, CompiledScenario } from '../../engine/compile';
import { countStartedPackets } from '../../engine/selectors';
import { usePlayback, usePlaybackDispatch } from '../../engine/store';
import { Icon } from '../common/Icon';
import { ProtocolChip } from '../common/ProtocolChip';
import { VisuallyHidden } from '../common/VisuallyHidden';
import { HeaderInspector } from '../details/HeaderInspector';
import { endpointText, formatWireTime, packetLength, protocolLabel } from './format';
import styles from './packets.module.css';

const COLUMN_COUNT = 8;

interface PacketRowViewProps {
  packet: CompiledPacket;
  compiled: CompiledScenario;
  current: boolean;
  selected: boolean;
  expanded: boolean;
  onSelect: (packet: CompiledPacket) => void;
  onToggle: (packet: CompiledPacket) => void;
}

const PacketRowView = memo(function PacketRowView({
  packet,
  compiled,
  current,
  selected,
  expanded,
  onSelect,
  onToggle,
}: PacketRowViewProps) {
  const def = packet.def;
  const number = packet.index + 1;
  const detailsId = `packet-${String(number)}-headers`;
  const outcome = def.outcome;
  const swatch = { '--chip': `var(--proto-${def.protocol})` } as CSSProperties;

  const onRowClick = (event: MouseEvent): void => {
    // The expand button has its own action.
    if (event.target instanceof Element && event.target.closest('[data-no-select]') !== null) {
      return;
    }

    onSelect(packet);
  };

  return (
    <>
      {/* Keyboard users select through the number button; the row click is a mouse convenience. */}
      <tr
        className={styles.row}
        data-current={current}
        data-selected={selected}
        aria-current={selected ? 'true' : undefined}
        onClick={onRowClick}
      >
        <td className={styles.expandCell} data-no-select>
          <button
            type="button"
            className={styles.expand}
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            aria-label={`Headers of packet ${String(number)}`}
            onClick={() => {
              onToggle(packet);
            }}
          >
            <Icon name="chevron" size={12} />
          </button>
        </td>
        <th scope="row" className={styles.numberCell}>
          <button
            type="button"
            className={styles.number}
            style={swatch}
            aria-label={`Select packet ${String(number)}`}
            onClick={() => {
              onSelect(packet);
            }}
          >
            {number}
          </button>
        </th>
        <td className={styles.time}>{formatWireTime(def.wireTimeMs)}</td>
        <td>{endpointText(compiled, def.from, def.meta?.ipv4?.src)}</td>
        <td>{endpointText(compiled, def.to, def.meta?.ipv4?.dst)}</td>
        <td>
          <ProtocolChip
            protocol={def.protocol}
            label={protocolLabel(def.protocol, def.encrypted)}
          />
        </td>
        <td className={styles.length}>{packetLength(def)}</td>
        <td className={styles.info}>
          {def.encrypted === true && (
            <span className={styles.lock} title="Encrypted">
              <Icon name="lock" size={12} />
              <VisuallyHidden>Encrypted: </VisuallyHidden>
            </span>
          )}
          {outcome !== undefined && outcome.kind !== 'delivered' && (
            <span className={styles.outcome} data-kind={outcome.kind}>
              {outcome.kind}
            </span>
          )}
          {def.summary}
        </td>
      </tr>
      {expanded && (
        <tr className={styles.detailsRow} id={detailsId} data-details-for={def.id}>
          <td colSpan={COLUMN_COUNT}>
            <HeaderInspector packet={packet} compiled={compiled} layout="columns" />
          </td>
        </tr>
      )}
    </>
  );
});

/**
 * Packets sent so far. Subscribes to the number of started packets (not the clock), so it re-renders
 * only when a row appears, and to the step and selection for highlighting.
 */
export function PacketTable() {
  const dispatch = usePlaybackDispatch();
  const compiled = usePlayback((_s, c) => c);
  const stepIndex = usePlayback((s) => s.stepIndex);
  const selectedId = usePlayback((s) => s.selectedPacketId);
  const count = usePlayback((s, c) => countStartedPackets(c, s.timeMs));

  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(0);
  const justExpanded = useRef<string | null>(null);

  // Keep the newest row in view by setting scrollTop on our own container (scrollIntoView would also
  // scroll the page).
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller !== null && count > previousCount.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }

    previousCount.current = count;
  }, [count]);

  // Reveal a row that was just expanded below the fold (again via scrollTop).
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const id = justExpanded.current;
    justExpanded.current = null;
    if (scroller === null || id === null || !expandedIds.has(id)) {
      return;
    }

    const details = scroller.querySelector<HTMLElement>(`tr[data-details-for="${CSS.escape(id)}"]`);
    if (details === null) {
      return;
    }

    const box = scroller.getBoundingClientRect();
    const overflow = details.getBoundingClientRect().bottom - box.bottom;
    if (overflow > 0) {
      scroller.scrollTop += overflow + 8;
    }
  }, [expandedIds]);

  const onSelect = useCallback(
    (packet: CompiledPacket) => {
      dispatch({ type: 'selectPacket', packetId: packet.def.id, seek: true });
    },
    [dispatch],
  );

  const onToggle = useCallback((packet: CompiledPacket) => {
    justExpanded.current = packet.def.id;
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(packet.def.id)) {
        next.add(packet.def.id);
      }

      return next;
    });
  }, []);

  const rows = compiled.packets.slice(0, count);

  return (
    <section className={styles.wrap} aria-label="Packets">
      {/* A scrollable region must be keyboard-focusable so it can be scrolled without a mouse. */}
      <div
        className={styles.scroller}
        ref={scrollRef}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label="Packet list"
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.expandCell}>
                <VisuallyHidden>Headers</VisuallyHidden>
              </th>
              <th scope="col">No.</th>
              <th scope="col">Time</th>
              <th scope="col">Source</th>
              <th scope="col">Destination</th>
              <th scope="col">Protocol</th>
              <th scope="col" className={styles.length}>
                Length
              </th>
              <th scope="col">Info</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMN_COUNT} className={styles.empty}>
                  No packets yet. Packets appear here as they are sent.
                </td>
              </tr>
            )}
            {rows.map((packet) => (
              <PacketRowView
                key={packet.def.id}
                packet={packet}
                compiled={compiled}
                current={packet.stepIndex === stepIndex}
                selected={packet.def.id === selectedId}
                expanded={expandedIds.has(packet.def.id)}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
