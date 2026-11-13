import type { CSSProperties } from 'react';
import type { ProtocolId } from '../../protocols/registry';
import { protocolInfo } from '../../protocols/registry';
import styles from './common.module.css';

interface ProtocolChipProps {
  protocol: ProtocolId;
  /** Show a coloured dot before the label (legend style). */
  dot?: boolean;
  /** Overrides the registry label, for example "HTTP (in TLS)". */
  label?: string;
}

/** Protocol pill in the protocol's colour. */
export function ProtocolChip({ protocol, dot = false, label }: ProtocolChipProps) {
  const style = { '--chip': `var(--proto-${protocol})` } as CSSProperties;

  return (
    <span className={styles.chip} style={style}>
      {dot && <i className={styles.chipDot} aria-hidden="true" />}
      <span className={styles.chipText}>{label ?? protocolInfo(protocol).label}</span>
    </span>
  );
}
