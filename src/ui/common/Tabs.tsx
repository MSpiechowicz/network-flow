import type { KeyboardEvent } from 'react';
import styles from './common.module.css';
import { panelId, tabId } from './tabIds';

export interface TabItem {
  id: string;
  label: string;
}

interface TabsProps {
  /** Accessible name of the tablist. */
  label: string;
  items: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Prefix for tab and panel ids; the caller gives each panel `id={panelId(idPrefix, item.id)}`. */
  idPrefix: string;
  variant?: 'segmented' | 'underline';
}

/** Tablist with automatic activation, roving tabindex and arrow/Home/End keys. Panels are the caller's. */
export function Tabs({
  label,
  items,
  value,
  onChange,
  idPrefix,
  variant = 'segmented',
}: TabsProps) {
  const select = (item: TabItem | undefined): void => {
    if (item === undefined) {
      return;
    }

    onChange(item.id);
    document.getElementById(tabId(idPrefix, item.id))?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const index = items.findIndex((item) => item.id === value);
    const last = items.length - 1;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      select(items[index >= last ? 0 : index + 1]);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      select(items[index <= 0 ? last : index - 1]);
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(items[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      select(items[last]);
    }
  };

  return (
    // The tablist itself is not focusable; the selected tab is (roving tabindex).
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      role="tablist"
      aria-label={label}
      className={`${styles.tablist} ${styles[variant]}`}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === value;

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, item.id)}
            className={styles.tab}
            aria-selected={selected}
            aria-controls={panelId(idPrefix, item.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(item.id);
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
