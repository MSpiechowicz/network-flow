import { useLayoutEffect, useRef } from 'react';
import { m } from 'motion/react';
import { usePlayback } from '../../engine/store';
import { Icon } from '../common/Icon';
import { VisuallyHidden } from '../common/VisuallyHidden';
import { ContentBlocks } from './ContentBlocks';
import styles from './details.module.css';
import { HeaderInspector } from './HeaderInspector';
import { latestStartedPacketId } from './latestPacket';
import { RichText } from './RichText';

/** Step text: re-renders when the step (or scenario) changes only. */
function StepContent() {
  const compiled = usePlayback((_s, c) => c);
  const stepIndex = usePlayback((s) => s.stepIndex);

  const step = compiled.steps[stepIndex]?.def;
  if (step === undefined) {
    return null;
  }

  const phase = compiled.def.phases?.find((p) => p.id === step.phase);
  const kicker = `Step ${String(stepIndex + 1)} of ${String(compiled.steps.length)}`;

  return (
    <>
      <p className={styles.kicker}>
        {kicker}
        {phase !== undefined && ` · ${phase.label}`}
      </p>
      <h2 className={styles.title}>{step.title}</h2>
      <p className={styles.summary}>
        <RichText text={step.summary} />
      </p>

      <ContentBlocks blocks={step.body} />

      {step.simplifications !== undefined && step.simplifications.length > 0 && (
        <section className={styles.simplified} aria-label="Simplified">
          <strong className={styles.simplifiedLabel}>Simplified</strong>
          <ul>
            {step.simplifications.map((item, index) => (
              <li key={index}>
                <RichText text={item} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {step.references !== undefined && step.references.length > 0 && (
        <section className={styles.references} aria-label="References">
          <h3 className={styles.sectionLabel}>References</h3>
          <ul>
            {step.references.map((reference) => (
              <li key={reference.url}>
                <a href={reference.url} target="_blank" rel="noopener noreferrer">
                  {reference.label} <Icon name="external" size={12} />
                  <VisuallyHidden>(opens in a new tab)</VisuallyHidden>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * Header inspector for the selected packet, or else the most recently sent packet of the step.
 * `latestStartedPacketId` returns a primitive, so this re-renders only when that packet changes.
 */
function SelectedPacketInspector() {
  const compiled = usePlayback((_s, c) => c);
  const selectedId = usePlayback((s) => s.selectedPacketId);
  const latestId = usePlayback((s, c) => latestStartedPacketId(c, s.stepIndex, s.timeMs));
  const stepHasPackets = usePlayback(
    (s, c) => (c.steps[s.stepIndex]?.packetIndices.length ?? 0) > 0,
  );

  const id = selectedId ?? latestId;
  const packet = id === null ? undefined : compiled.packets.find((p) => p.def.id === id);

  if (packet === undefined) {
    return (
      <section className={styles.inspectorSection} aria-label="Packet headers">
        <h3 className={styles.sectionLabel}>Packet headers</h3>
        <p className={styles.empty}>
          {stepHasPackets
            ? 'No packet sent yet. Press play to send this step’s packets.'
            : 'This step sends no packets; it is local work on one device.'}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.inspectorSection} aria-label="Packet headers">
      <h3 className={styles.sectionLabel}>
        Packet {packet.index + 1} · {packet.def.label}
        {selectedId === null && <span className={styles.auto}> (latest in this step)</span>}
      </h3>
      <HeaderInspector packet={packet} compiled={compiled} />
    </section>
  );
}

/** Right-hand panel: step text and the packet header inspector. */
export function StepDetails() {
  const stepIndex = usePlayback((s) => s.stepIndex);
  const scenarioId = usePlayback((s) => s.scenarioId);
  const scrollRef = useRef<HTMLElement>(null);

  // Start each step at the top of the panel (scrollTop, never scrollIntoView).
  useLayoutEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = 0;
    }
  }, [stepIndex, scenarioId]);

  return (
    <section className={styles.panel} aria-label="Step details" ref={scrollRef}>
      <m.div
        key={`${scenarioId}/${String(stepIndex)}`}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        <StepContent />
        <SelectedPacketInspector />
      </m.div>
    </section>
  );
}
