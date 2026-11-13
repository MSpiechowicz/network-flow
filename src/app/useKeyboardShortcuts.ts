import { useEffect, useEffectEvent } from 'react';
import type { PlaybackStore } from '../engine/store';

const SEEK_MS = 1000;

interface ShortcutOptions {
  /** While a modal dialog is open all shortcuts are off (the dialog handles Esc itself). */
  dialogOpen: boolean;
  onOpenShortcuts: () => void;
  /** Whether the sidebar drawer/overlay is open, so Esc can close it. */
  navOpen: boolean;
  onCloseNav: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

/** Controls that activate on Space/Enter themselves; Space must stay theirs. */
function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a[href], summary, [role="button"], [role="tab"]') !== null
  );
}

function isTab(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="tab"]') !== null;
}

/**
 * Global keyboard map (plan section 7). Ignored while focus is in an input, select, textarea or
 * contenteditable element (so the scrubber keeps its own arrow keys) or while a dialog is open.
 *
 * Space/K play-pause, ArrowRight/L next, ArrowLeft/J previous, Shift+Arrow seek ±1 s, Home/End first/last
 * step, -/= (or +) speed, V toggle view, ? shortcuts dialog, Esc closes the drawer.
 */
export function useKeyboardShortcuts(store: PlaybackStore, options: ShortcutOptions): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (options.dialogOpen || isTypingTarget(event.target)) {
      return;
    }

    const { dispatch } = store;
    const key = event.key;

    if (key === 'Escape') {
      if (options.navOpen) {
        event.preventDefault();
        options.onCloseNav();
      }

      return;
    }

    // Tabs use the arrow keys and Home/End themselves.
    if (isTab(event.target) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      return;
    }

    if (key === ' ') {
      // A focused button/link is activated by Space; do not also toggle playback.
      if (!isActivatable(event.target)) {
        event.preventDefault();
        dispatch({ type: 'toggle' });
      }

      return;
    }

    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      event.preventDefault();

      if (event.shiftKey) {
        const delta = key === 'ArrowRight' ? SEEK_MS : -SEEK_MS;
        dispatch({ type: 'seek', timeMs: store.getState().timeMs + delta });
      } else {
        dispatch({ type: key === 'ArrowRight' ? 'nextStep' : 'prevStep' });
      }

      return;
    }

    switch (key.toLowerCase()) {
      case 'k':
        dispatch({ type: 'toggle' });
        break;
      case 'l':
        dispatch({ type: 'nextStep' });
        break;
      case 'j':
        dispatch({ type: 'prevStep' });
        break;
      case 'home':
        event.preventDefault();
        dispatch({ type: 'firstStep' });
        break;
      case 'end':
        event.preventDefault();
        dispatch({ type: 'lastStep' });
        break;
      case '-':
        dispatch({ type: 'speedDown' });
        break;
      case '=':
      case '+':
        dispatch({ type: 'speedUp' });
        break;
      case 'v':
        dispatch({ type: 'toggleView' });
        break;
      case '?':
        event.preventDefault();
        options.onOpenShortcuts();
        break;
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
