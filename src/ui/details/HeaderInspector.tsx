import type { CSSProperties } from 'react';
import type { CompiledPacket, CompiledScenario } from '../../engine/compile';
import type { HeaderGroup, Layer } from '../../model/types';
import { protocolInfo } from '../../protocols/registry';
import { Icon } from '../common/Icon';
import styles from './details.module.css';
import { relativeTcp } from './tcpRelative';

const LAYER_ORDER: readonly Layer[] = ['link', 'internet', 'transport', 'application'];

const LAYER_LABEL: Record<Layer, string> = {
  link: 'Link',
  internet: 'Internet',
  transport: 'Transport',
  application: 'Application',
};

interface HeaderInspectorProps {
  packet: CompiledPacket;
  compiled: CompiledScenario;
  /** `stack` for the details panel, `columns` for the expanded table row. */
  layout?: 'stack' | 'columns';
}

function GroupCard({ group }: { group: HeaderGroup }) {
  const info = protocolInfo(group.protocol);
  const showTitle = group.title !== undefined && group.title !== info.label;

  return (
    <section
      className={styles.group}
      aria-label={`${info.label} header`}
      style={{ '--hue': `var(--proto-${group.protocol})` } as CSSProperties}
    >
      <header className={styles.groupHead}>
        <h4>
          <span className={styles.groupProto}>{info.label}</span>
          {showTitle && <span className={styles.groupTitle}> · {group.title}</span>}
        </h4>
        <span className={styles.layerTag}>{LAYER_LABEL[group.layer]}</span>
      </header>
      <dl className={styles.fields}>
        {group.fields.map((field, index) => (
          <div className={styles.field} key={`${field.name}-${String(index)}`}>
            <dt>{field.name}</dt>
            <dd>
              {field.value}
              {field.note !== undefined && <span className={styles.fieldNote}>{field.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SequenceCard({
  packet,
  compiled,
}: {
  packet: CompiledPacket;
  compiled: CompiledScenario;
}) {
  const tcp = packet.def.meta?.tcp;
  if (tcp === undefined) {
    return null;
  }

  const relative = relativeTcp(
    compiled.packets.map((p) => p.def),
    tcp,
  );
  const hasAck = tcp.ack !== undefined && tcp.flags.includes('ACK');

  return (
    <section className={styles.group} aria-label="TCP sequence numbers">
      <header className={styles.groupHead}>
        <h4>TCP sequence numbers</h4>
        <span className={styles.layerTag}>Absolute · relative</span>
      </header>
      <dl className={styles.fields}>
        <div className={styles.field}>
          <dt>Seq</dt>
          <dd>
            {tcp.seq}
            {relative !== undefined && (
              <span className={styles.fieldNote}>relative {relative.seq}</span>
            )}
          </dd>
        </div>
        {hasAck && (
          <div className={styles.field}>
            <dt>Ack</dt>
            <dd>
              {tcp.ack}
              {relative?.ack !== undefined && (
                <span className={styles.fieldNote}>relative {relative.ack}</span>
              )}
            </dd>
          </div>
        )}
        <div className={styles.field}>
          <dt>Payload</dt>
          <dd>{tcp.len} bytes</dd>
        </div>
      </dl>
    </section>
  );
}

/** Header fields of one packet, grouped by layer (link, internet, transport, application). */
export function HeaderInspector({ packet, compiled, layout = 'stack' }: HeaderInspectorProps) {
  const def = packet.def;
  const groups = [...def.headers].sort(
    (a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer),
  );
  const sequenceAfter = groups.findIndex((g) => g.protocol === 'tcp');
  const outcome = def.outcome;

  return (
    <div className={styles.inspector} data-layout={layout}>
      {def.encrypted === true && (
        <p className={styles.badge}>
          <Icon name="lock" size={13} /> Encrypted on the wire: the payload below is what the two
          ends see, not what an observer sees.
        </p>
      )}
      {outcome !== undefined && outcome.kind !== 'delivered' && (
        <p className={styles.badge} data-kind={outcome.kind}>
          <strong>{outcome.kind}</strong> {outcome.note}
        </p>
      )}

      {groups.map((group, index) => (
        <div key={`${group.protocol}-${String(index)}`} className={styles.groupWrap}>
          <GroupCard group={group} />
          {index === sequenceAfter && <SequenceCard packet={packet} compiled={compiled} />}
        </div>
      ))}
      {sequenceAfter < 0 && <SequenceCard packet={packet} compiled={compiled} />}

      {def.payload !== undefined && (
        <section className={styles.group} aria-label="Payload">
          <header className={styles.groupHead}>
            <h4>Payload</h4>
            {def.sizeBytes !== undefined && (
              <span className={styles.layerTag}>{def.sizeBytes} bytes on the wire</span>
            )}
          </header>
          <pre className={styles.payload}>{def.payload}</pre>
        </section>
      )}
    </div>
  );
}
