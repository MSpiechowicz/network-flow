import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { Icon } from '../ui/common/Icon';
import styles from './ShortcutsDialog.module.css';

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Each row: alternative key combinations (keys inside a combination are pressed together). */
const SHORTCUTS: readonly { combos: readonly (readonly string[])[]; action: string }[] = [
  { combos: [['Space'], ['K']], action: 'Play or pause' },
  { combos: [['→'], ['L']], action: 'Next step' },
  { combos: [['←'], ['J']], action: 'Previous step (or restart this one)' },
  { combos: [['Shift', '→']], action: 'Seek forward 1 second' },
  { combos: [['Shift', '←']], action: 'Seek back 1 second' },
  { combos: [['Home']], action: 'First step' },
  { combos: [['End']], action: 'Last step' },
  { combos: [['-']], action: 'Slower' },
  { combos: [['='], ['+']], action: 'Faster' },
  { combos: [['V']], action: 'Switch between Network and Sequence view' },
  { combos: [['?']], action: 'Show this list' },
  { combos: [['Esc']], action: 'Close this dialog or the sidebar drawer' },
];

/** Native modal `<dialog>`: focus is trapped and restored by the browser, Esc closes it. */
export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>): void => {
    // The dialog element itself has no padding, so a click on it is a click on the backdrop.
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="shortcuts-title"
      onClose={onClose}
      onClick={onBackdropClick}
    >
      <div className={styles.body}>
        <header className={styles.head}>
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <p className={styles.note}>
          Shortcuts are off while a form control has focus. The timeline slider uses the arrow keys
          for small seeks.
        </p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Keys</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((shortcut) => (
              <tr key={shortcut.action}>
                <td>
                  {shortcut.combos.map((combo, comboIndex) => (
                    <span key={combo.join('+')}>
                      {comboIndex > 0 && <span className={styles.or}> or </span>}
                      {combo.map((key, keyIndex) => (
                        <span key={key}>
                          {keyIndex > 0 && <span className={styles.or}> + </span>}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </span>
                  ))}
                </td>
                <td>{shortcut.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </dialog>
  );
}
