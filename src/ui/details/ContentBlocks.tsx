import type { ContentBlock } from '../../model/types';
import styles from './details.module.css';
import { RichText } from './RichText';

const CALLOUT_LABEL = { note: 'Note', tip: 'Tip', warning: 'Warning' } as const;

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'p':
      return (
        <p className={styles.paragraph}>
          <RichText text={block.text} />
        </p>
      );

    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <RichText text={item} />
        </li>
      ));

      return block.ordered === true ? (
        <ol className={`${styles.list} ${styles.ordered}`}>{items}</ol>
      ) : (
        <ul className={styles.list}>{items}</ul>
      );
    }

    case 'code':
      return (
        <figure className={styles.codeBlock}>
          {block.caption !== undefined && <figcaption>{block.caption}</figcaption>}
          {/* Scrollable, so keyboard-focusable. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <pre tabIndex={0}>
            <code>{block.text}</code>
          </pre>
        </figure>
      );

    case 'callout':
      return (
        <div className={styles.callout} data-tone={block.tone} role="note">
          <strong className={styles.calloutLabel}>{CALLOUT_LABEL[block.tone]}</strong>
          <p>
            <RichText text={block.text} />
          </p>
        </div>
      );
  }
}

export function ContentBlocks({ blocks }: { blocks: readonly ContentBlock[] }) {
  return (
    <div className={styles.blocks}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
