import type { ViewMode } from '../../engine/playback';
import { usePlayback, usePlaybackDispatch } from '../../engine/store';
import { Tabs } from '../common/Tabs';
import type { TabItem } from '../common/Tabs';

export const VIEW_TAB_PREFIX = 'view';

const VIEW_TABS: readonly TabItem[] = [
  { id: 'network', label: 'Network' },
  { id: 'sequence', label: 'Sequence' },
];

/** Network / Sequence switch. The caller renders the `tabpanel` (see `VIEW_TAB_PREFIX`). */
export function ViewToggle() {
  const view = usePlayback((s) => s.view);
  const dispatch = usePlaybackDispatch();

  return (
    <Tabs
      label="View"
      items={VIEW_TABS}
      value={view}
      idPrefix={VIEW_TAB_PREFIX}
      onChange={(id) => {
        dispatch({ type: 'setView', view: id as ViewMode });
      }}
    />
  );
}
