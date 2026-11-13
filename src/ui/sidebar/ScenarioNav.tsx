import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { serializeRoute } from '../../app/routing';
import { usePlayback, usePlaybackDispatch } from '../../engine/store';
import type { ScenarioDef } from '../../model/types';
import { CATEGORY_LABELS, CATEGORY_ORDER, SCENARIOS } from '../../scenarios';
import { Icon } from '../common/Icon';
import { groupStepsByPhase, monogram } from './phaseGroups';
import styles from './ScenarioNav.module.css';

interface ScenarioNavProps {
  /** Overlay (rail) or drawer state; ignored by the always-open desktop layout. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ScenarioStepsProps {
  scenario: ScenarioDef;
  /** Step index of the loaded step when this is the loaded scenario, otherwise -1. */
  currentStep: number;
  view: 'network' | 'sequence';
  onLinkClick: (
    event: MouseEvent<HTMLAnchorElement>,
    scenarioId: string,
    stepIndex: number,
  ) => void;
}

function ScenarioSteps({ scenario, currentStep, view, onLinkClick }: ScenarioStepsProps) {
  return (
    <div className={styles.steps} id={`steps-${scenario.id}`}>
      {groupStepsByPhase(scenario).map((group, groupIndex) => (
        <div key={groupIndex} className={styles.group} role="group" aria-label={group.label}>
          {group.label !== undefined && <p className={styles.phase}>{group.label}</p>}
          <ol>
            {group.steps.map(({ step, index }) => {
              const state =
                index === currentStep ? 'current' : index < currentStep ? 'done' : 'todo';

              return (
                <li key={step.id}>
                  <a
                    className={styles.step}
                    data-state={state}
                    href={serializeRoute({ scenarioId: scenario.id, stepIndex: index, view })}
                    aria-current={state === 'current' ? 'step' : undefined}
                    onClick={(event) => {
                      onLinkClick(event, scenario.id, index);
                    }}
                  >
                    <i className={styles.num}>{index + 1}</i>
                    <span>{step.title}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}

/** Scenario list grouped by category; each scenario is a disclosure listing its steps as links. */
export function ScenarioNav({ open, onOpenChange }: ScenarioNavProps) {
  const dispatch = usePlaybackDispatch();
  const scenarioId = usePlayback((s) => s.scenarioId);
  const stepIndex = usePlayback((s) => s.stepIndex);
  const view = usePlayback((s) => s.view);

  const [expandedId, setExpandedId] = useState<string | null>(scenarioId);
  const [seenScenarioId, setSeenScenarioId] = useState(scenarioId);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The loaded scenario is always the open one after navigation.
  if (seenScenarioId !== scenarioId) {
    setSeenScenarioId(scenarioId);
    setExpandedId(scenarioId);
  }

  useEffect(() => {
    if (open) {
      toggleRef.current?.focus();
    }
  }, [open]);

  // Keep the current step visible by adjusting our own scrollTop (never scrollIntoView).
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const current = scroller?.querySelector<HTMLElement>('[aria-current="step"]');
    if (scroller === null || current === null || current === undefined) {
      return;
    }

    const box = scroller.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (box.height === 0) {
      return;
    }

    // Only move when the step is (nearly) out of view; then put it a third of the way down.
    if (item.bottom > box.bottom - 8 || item.top < box.top + 8) {
      scroller.scrollTop += item.top - box.top - box.height / 3;
    }
  }, [stepIndex, scenarioId, expandedId]);

  const onLinkClick = (
    event: MouseEvent<HTMLAnchorElement>,
    linkScenarioId: string,
    linkStepIndex: number,
  ): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    onOpenChange(false);

    // The href equals the current hash, so the browser fires no hashchange: restart the step here.
    if (linkScenarioId === scenarioId && linkStepIndex === stepIndex) {
      dispatch({ type: 'goToStep', stepIndex: linkStepIndex });
    }
  };

  return (
    <nav className={styles.nav} aria-label="Scenarios" data-open={open}>
      <div className={styles.top}>
        <button
          ref={toggleRef}
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-label={open ? 'Close scenario list' : 'Open scenario list'}
          onClick={() => {
            onOpenChange(!open);
          }}
        >
          <Icon name={open ? 'close' : 'menu'} size={18} />
        </button>
        <span className={styles.topTitle}>Scenarios</span>
      </div>

      <ul className={styles.rail}>
        {SCENARIOS.map((scenario) => (
          <li key={scenario.id}>
            <button
              type="button"
              className={styles.monogram}
              aria-label={scenario.title}
              title={scenario.title}
              aria-current={scenario.id === scenarioId ? 'true' : undefined}
              onClick={() => {
                setExpandedId(scenario.id);
                onOpenChange(true);
              }}
            >
              {monogram(scenario.title)}
            </button>
          </li>
        ))}
      </ul>

      <div className={styles.full} ref={scrollRef}>
        {CATEGORY_ORDER.map((category) => {
          const scenarios = SCENARIOS.filter((s) => s.category === category);
          if (scenarios.length === 0) {
            return null;
          }

          return (
            <section key={category} aria-label={CATEGORY_LABELS[category]}>
              <h2 className={styles.category}>{CATEGORY_LABELS[category]}</h2>
              {scenarios.map((scenario) => {
                const expanded = expandedId === scenario.id;
                const loaded = scenario.id === scenarioId;

                return (
                  <div key={scenario.id}>
                    <button
                      type="button"
                      className={styles.scenario}
                      data-loaded={loaded}
                      aria-expanded={expanded}
                      aria-controls={expanded ? `steps-${scenario.id}` : undefined}
                      onClick={() => {
                        setExpandedId(expanded ? null : scenario.id);
                      }}
                    >
                      <span className={styles.scenarioTitle}>{scenario.title}</span>
                      <small>{scenario.steps.length} steps</small>
                    </button>
                    {expanded && (
                      <ScenarioSteps
                        scenario={scenario}
                        currentStep={loaded ? stepIndex : -1}
                        view={view}
                        onLinkClick={onLinkClick}
                      />
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </nav>
  );
}
