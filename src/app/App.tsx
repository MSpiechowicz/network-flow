import { useCallback, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { LazyMotion, MotionConfig, domAnimation, m } from 'motion/react';
import { countStartedPackets } from '../engine/selectors';
import {
  PlaybackProvider,
  createPlaybackStore,
  usePlayback,
  usePlaybackStore,
} from '../engine/store';
import type { PlaybackStore } from '../engine/store';
import { useClock } from '../engine/useClock';
import { SCENARIOS } from '../scenarios';
import { PlaybackBar } from '../ui/controls/PlaybackBar';
import { VIEW_TAB_PREFIX, ViewToggle } from '../ui/controls/ViewToggle';
import { Icon } from '../ui/common/Icon';
import { LiveAnnouncer } from '../ui/common/LiveAnnouncer';
import { ProtocolChip } from '../ui/common/ProtocolChip';
import { Tabs } from '../ui/common/Tabs';
import type { TabItem } from '../ui/common/Tabs';
import { panelId, tabId } from '../ui/common/tabIds';
import { useMediaQuery } from '../ui/common/useMediaQuery';
import { StepDetails } from '../ui/details/StepDetails';
import { PacketTable } from '../ui/packets/PacketTable';
import { NetworkScene } from '../ui/scene/NetworkScene';
import { SequenceView } from '../ui/sequence/SequenceView';
import { ScenarioNav } from '../ui/sidebar/ScenarioNav';
import styles from './App.module.css';
import { parseHash } from './routing';
import { ShortcutsDialog } from './ShortcutsDialog';
import { useHashSync } from './useHashSync';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { initialMotion, useMotionPreference } from './useMotionPreference';
import { Logo } from '../ui/common/Logo';

const DETAIL_TABS: readonly TabItem[] = [
  { id: 'step', label: 'Step' },
  { id: 'packets', label: 'Packets' },
];
const DETAIL_TAB_PREFIX = 'detail';

function createAppStore(): PlaybackStore {
  const route = parseHash(window.location.hash, SCENARIOS);

  return createPlaybackStore(SCENARIOS, { ...route, motion: initialMotion() });
}

function HeaderProgress() {
  const stepIndex = usePlayback((s) => s.stepIndex);
  const stepCount = usePlayback((_s, c) => c.steps.length);
  // Changes only when a packet is sent, not on every tick.
  const packets = usePlayback((s, c) => countStartedPackets(c, s.timeMs));

  return (
    <span className={styles.progress}>
      step {stepIndex + 1}/{stepCount} · {packets} {packets === 1 ? 'packet' : 'packets'}
    </span>
  );
}

function NowShowing() {
  const title = usePlayback((_s, c) => c.def.title);
  const tagline = usePlayback((_s, c) => c.def.tagline);

  return (
    <p className={styles.now}>
      Now showing <strong>{title}</strong>
      <span className={styles.tagline}> · {tagline}</span>
    </p>
  );
}

function ProtocolLegend() {
  const protocols = usePlayback((_s, c) => c.def.protocols);

  return (
    <ul className={styles.legend} aria-label="Protocols in this scenario">
      {protocols.map((protocol) => (
        <li key={protocol}>
          <ProtocolChip protocol={protocol} dot />
        </li>
      ))}
    </ul>
  );
}

function ScenePanel() {
  const view = usePlayback((s) => s.view);

  return (
    <main className={styles.scene} id="main" tabIndex={-1}>
      <div className={styles.sceneBar}>
        <ViewToggle />
        <ProtocolLegend />
      </div>
      <div
        className={styles.sceneBody}
        role="tabpanel"
        id={panelId(VIEW_TAB_PREFIX, view)}
        aria-labelledby={tabId(VIEW_TAB_PREFIX, view)}
      >
        <m.div
          key={view}
          className={styles.sceneFill}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
        >
          {view === 'network' ? <NetworkScene /> : <SequenceView />}
        </m.div>
      </div>
    </main>
  );
}

/** Details and packets as tabs under the scene (768-1023px). */
function DetailTabs() {
  const [tab, setTab] = useState('step');

  return (
    <section className={styles.panel} aria-label="Details and packets">
      <Tabs
        label="Details"
        items={DETAIL_TABS}
        value={tab}
        onChange={setTab}
        idPrefix={DETAIL_TAB_PREFIX}
        variant="underline"
      />
      <div
        className={styles.panelBody}
        role="tabpanel"
        id={panelId(DETAIL_TAB_PREFIX, tab)}
        aria-labelledby={tabId(DETAIL_TAB_PREFIX, tab)}
      >
        {tab === 'step' ? <StepDetails /> : <PacketTable />}
      </div>
    </section>
  );
}

function Shell() {
  const store = usePlaybackStore();
  useClock(store);
  useHashSync(store);
  useMotionPreference(store);

  const isTablet = useMediaQuery('(max-width: 1023px)');
  const [navOpen, setNavOpenState] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const setNavOpen = useCallback((open: boolean) => {
    if (open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else {
      openerRef.current?.focus();
    }

    setNavOpenState(open);
  }, []);

  useKeyboardShortcuts(store, {
    dialogOpen: shortcutsOpen,
    onOpenShortcuts: () => {
      setShortcutsOpen(true);
    },
    navOpen,
    onCloseNav: () => {
      setNavOpen(false);
    },
  });

  const skipToScene = (event: MouseEvent<HTMLAnchorElement>): void => {
    // A plain `#main` link would change the hash and reload the route.
    event.preventDefault();
    document.getElementById('main')?.focus();
  };

  return (
    <div className={styles.app} data-nav-open={navOpen}>
      <a className={styles.skip} href="#main" onClick={skipToScene}>
        Skip to scene and controls
      </a>

      <header className={styles.header}>
        <button
          type="button"
          className={styles.menuButton}
          aria-label="Open scenario list"
          aria-expanded={navOpen}
          onClick={() => {
            setNavOpen(true);
          }}
        >
          <Icon name="menu" size={18} />
        </button>
        <h1 className={styles.brand}>
          <Logo size={26} />
          Network Flow
        </h1>
        <NowShowing />
        <HeaderProgress />
      </header>

      <div className={styles.navCell}>
        <ScenarioNav open={navOpen} onOpenChange={setNavOpen} />
      </div>
      <div
        className={styles.scrim}
        role="presentation"
        onClick={() => {
          setNavOpen(false);
        }}
      />

      <ScenePanel />

      <div className={styles.bar}>
        <PlaybackBar
          onOpenShortcuts={() => {
            setShortcutsOpen(true);
          }}
        />
      </div>

      {isTablet ? (
        <DetailTabs />
      ) : (
        <>
          <div className={styles.details}>
            <StepDetails />
          </div>
          <div className={styles.table}>
            <PacketTable />
          </div>
        </>
      )}

      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => {
          setShortcutsOpen(false);
        }}
      />
      <LiveAnnouncer />
    </div>
  );
}

function MotionProviders({ children }: { children: ReactNode }) {
  const reduced = usePlayback((s) => s.motion === 'reduced');

  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}

function LoadedApp() {
  const [store] = useState(createAppStore);

  return (
    <PlaybackProvider store={store}>
      <MotionProviders>
        <Shell />
      </MotionProviders>
    </PlaybackProvider>
  );
}

export function App() {
  if (SCENARIOS.length === 0) {
    return (
      <main className={styles.empty}>
        <h1>Network Flow</h1>
        <p>No scenarios are registered. Add a file to src/scenarios/data/.</p>
      </main>
    );
  }

  return <LoadedApp />;
}
