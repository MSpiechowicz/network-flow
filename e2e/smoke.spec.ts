/// <reference lib="dom" />
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ScenarioDef } from '../src/model/types';

/*
 * Browser smoke path (plan section 6). Scenario facts (ids, node and step counts) come from the data
 * files themselves, so adding a scenario extends the loops below. No pixel positions or screenshots.
 */

const DATA_DIR = join(import.meta.dirname, '..', 'src', 'scenarios', 'data');
const JOURNEY = 'url-journey';

const CATEGORIES: readonly { id: ScenarioDef['category']; heading: string }[] = [
  { id: 'journey', heading: 'Journey' },
  { id: 'foundations', heading: 'Foundations' },
  { id: 'network-services', heading: 'Network services' },
  { id: 'web', heading: 'Web' },
  { id: 'email', heading: 'Email' },
];

async function loadScenarios(): Promise<ScenarioDef[]> {
  const files = readdirSync(DATA_DIR).filter((file) => file.endsWith('.ts'));
  const scenarios: ScenarioDef[] = [];

  for (const file of files) {
    const module = (await import(pathToFileURL(join(DATA_DIR, file)).href)) as {
      default: ScenarioDef;
    };
    scenarios.push(module.default);
  }

  const rank = (s: ScenarioDef): number => CATEGORIES.findIndex((c) => c.id === s.category);

  return scenarios.sort((a, b) => rank(a) - rank(b) || a.order - b.order);
}

/**
 * Every test fails on a console error, an uncaught page error, or a request that leaves the app's
 * origin (the app must work without any third-party host).
 */
const test = base.extend<{ guard: undefined }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const origin = new URL(baseURL ?? 'http://localhost:4173').origin;
      const problems: string[] = [];

      page.on('console', (message) => {
        if (message.type() === 'error') {
          problems.push(`console error: ${message.text()}`);
        }
      });
      page.on('pageerror', (error) => {
        problems.push(`page error: ${error.message}`);
      });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (/^(https?|wss?):$/.test(url.protocol) && url.origin !== origin) {
          problems.push(`request left the origin: ${request.url()}`);
        }
      });

      await use(undefined);

      expect(problems, 'console errors, page errors and off-origin requests').toEqual([]);
    },
    { auto: true },
  ],
});

const stepHash = (id: string, step: number, view?: string): string =>
  `#/${id}/${String(step)}${view === undefined ? '' : `?view=${view}`}`;

const detailsPanel = (page: Page): Locator => page.getByRole('region', { name: 'Step details' });
const packetTable = (page: Page): Locator =>
  page.getByRole('region', { name: 'Packets', exact: true }).getByRole('table');
const playButton = (page: Page): Locator => page.getByRole('button', { name: 'Play', exact: true });
const pauseButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Pause', exact: true });
const sceneSvg = (page: Page): Locator => page.locator('svg[data-scenario]');

async function expectKicker(page: Page, step: number, total?: number): Promise<void> {
  const count = total === undefined ? String.raw`\d+` : String(total);

  await expect(
    detailsPanel(page).getByText(new RegExp(`^Step ${String(step)} of ${count}`)),
  ).toBeVisible();
}

/** Resolves once the app has mounted: a scene panel (either view) and the step panel are rendered. */
async function openApp(page: Page, hash = ''): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator('[role="tabpanel"][id^="view-panel-"]')).toBeVisible();
  await expect(detailsPanel(page).getByRole('heading', { level: 2 })).toBeVisible();
}

/** Position of every glyph over `durationMs`, per packet id (main copies only), as `x,y` strings. */
async function samplePacketPositions(
  page: Page,
  durationMs: number,
): Promise<Record<string, string[]>> {
  return page.evaluate(async (duration) => {
    const seen: Record<string, Set<string>> = {};
    const end = performance.now() + duration;

    while (performance.now() < end) {
      for (const glyph of document.querySelectorAll('[data-packet][data-copy="0"]')) {
        const id = glyph.getAttribute('data-packet') ?? '';
        const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(
          glyph.getAttribute('transform') ?? '',
        );
        if (match !== null) {
          (seen[id] ??= new Set()).add(`${match[1] ?? ''},${match[2] ?? ''}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    return Object.fromEntries(Object.entries(seen).map(([id, set]) => [id, [...set]]));
  }, durationMs);
}

const scenarios = await loadScenarios();
const journey = scenarios.find((s) => s.id === JOURNEY);
if (journey === undefined) {
  throw new Error(`Scenario ${JOURNEY} is missing`);
}

test('1. opens the URL journey paused at step 1 and normalises the hash', async ({ page }) => {
  await openApp(page);

  await expect(page).toHaveURL(/#\/url-journey\/1$/);
  await expectKicker(page, 1, journey.steps.length);
  await expect(sceneSvg(page)).toHaveAttribute('data-scenario', JOURNEY);
  await expect(page.locator('[data-node]')).toHaveCount(journey.nodes.length);
  await expect(playButton(page)).toBeVisible();
});

test('2. sidebar lists every scenario by category, in order', async ({ page }) => {
  await openApp(page);

  const nav = page.getByRole('navigation', { name: 'Scenarios' });
  await expect(nav.getByRole('heading', { level: 2 })).toHaveText(CATEGORIES.map((c) => c.heading));

  for (const category of CATEGORIES) {
    const section = nav.getByRole('region', { name: category.heading });
    const expected = scenarios.filter((s) => s.category === category.id);

    await expect(section.locator('button[aria-expanded]')).toHaveCount(expected.length);
    for (const [index, scenario] of expected.entries()) {
      await expect(section.locator('button[aria-expanded]').nth(index)).toContainText(
        scenario.title,
      );
    }
  }
  expect(scenarios).toHaveLength(11);

  // The loaded scenario lists numbered steps, with the current one marked.
  const steps = nav.locator(`#steps-${JOURNEY} a`);
  await expect(steps).toHaveCount(journey.steps.length);
  await expect(nav.locator('a[aria-current="step"]')).toHaveCount(1);
  // Steps are grouped by phase where the scenario defines phases.
  await expect(nav.locator(`#steps-${JOURNEY} [role="group"]`)).toHaveCount(
    journey.phases?.length ?? 0,
  );

  await steps.nth(4).click();
  await expect(page).toHaveURL(/#\/url-journey\/5$/);
  await expectKicker(page, 5);
  await expect(steps.nth(4)).toHaveAttribute('aria-current', 'step');
  await expect(playButton(page)).toBeVisible();
});

test('3. With "Pause each step" on, Space plays, the step auto-pauses, ArrowRight advances', async ({
  page,
}) => {
  await openApp(page);

  // Auto-pause is off by default; this test is about the opt-in behaviour.
  const autoPause = page.getByRole('button', { name: 'Pause each step' });
  await expect(autoPause).toHaveAttribute('aria-pressed', 'false');
  await autoPause.click();
  await expect(autoPause).toHaveAttribute('aria-pressed', 'true');
  // Leave the toggle, or Space would press it again instead of playing.
  await autoPause.blur();

  // 2x keeps the test short: "=" twice goes 1x, 1.5x, 2x.
  await page.keyboard.press('=');
  await page.keyboard.press('=');

  await page.keyboard.press('Space');
  await expect(pauseButton(page)).toBeVisible();

  await expect(playButton(page)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/#\/url-journey\/1$/);

  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/url-journey\/2$/);
  await expectKicker(page, 2);
});

test('4. "v" switches to the sequence view and a reload restores view and step', async ({
  page,
}) => {
  await openApp(page, stepHash(JOURNEY, 3));

  await page.keyboard.press('v');
  await expect(page.getByRole('tab', { name: 'Sequence' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#view-panel-sequence')).toBeVisible();
  await expect(page).toHaveURL(/#\/url-journey\/3\?view=sequence$/);

  await page.reload();
  await expect(page.locator('#view-panel-sequence')).toBeVisible();
  await expectKicker(page, 3);

  await page.keyboard.press('v');
  await expect(page.locator('#view-panel-network')).toBeVisible();
  await expect(page).toHaveURL(/#\/url-journey\/3$/);
});

test('5. a deep link in a new tab restores scenario, step and view', async ({ context, page }) => {
  await openApp(page, stepHash('tcp', 4, 'sequence'));
  const url = page.url();

  const other = await context.newPage();
  await other.goto(url);

  await expect(other.locator('#view-panel-sequence')).toBeVisible();
  await expectKicker(other, 4);
  await expect(other).toHaveURL(/#\/tcp\/4\?view=sequence$/);
  await expect(other.locator('a[aria-current="step"]')).toHaveCount(1);
});

test('6. a table row selects its packet and the inspector shows its protocol', async ({ page }) => {
  // Step 10 is paused at its start, so the earlier packets are already listed.
  await openApp(page, stepHash(JOURNEY, 10));

  for (const name of ['No.', 'Time', 'Source', 'Destination', 'Protocol', 'Length', 'Info']) {
    await expect(packetTable(page).getByRole('columnheader', { name })).toBeVisible();
  }

  const rows = packetTable(page).locator('tbody tr[data-current]');
  await expect(rows.first()).toBeVisible();

  const first = rows.first();
  const protocol = (await first.getByRole('cell').nth(4).innerText()).replace(/ \(in TLS\)$/, '');
  await first.getByRole('cell').nth(1).click();

  await expect(first).toHaveAttribute('aria-current', 'true');
  const inspector = detailsPanel(page).getByRole('region', { name: 'Packet headers' });
  await expect(inspector.getByRole('heading', { name: /^Packet 1 ·/ })).toBeVisible();
  await expect(inspector.getByRole('region', { name: `${protocol} header` })).toBeVisible();

  // Rows expand to show their headers.
  const expand = first.getByRole('button', { name: 'Headers of packet 1' });
  await expand.click();
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
  await expect(packetTable(page).locator('tr[data-details-for]')).toBeVisible();
});

test('7. every scenario loads at step 1 and reaches its last step with End', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);

  const nav = page.getByRole('navigation', { name: 'Scenarios' });

  for (const scenario of scenarios) {
    const toggle = nav.locator('button[aria-expanded]').filter({ hasText: scenario.title });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await nav.locator(`#steps-${scenario.id} a`).first().click();

    await expect(page).toHaveURL(new RegExp(`#/${scenario.id}/1$`));
    await expectKicker(page, 1, scenario.steps.length);
    await expect(sceneSvg(page)).toHaveAttribute('data-scenario', scenario.id);
    await expect(page.locator('[data-node]')).toHaveCount(scenario.nodes.length);

    await page.keyboard.press('End');
    await expect(page).toHaveURL(new RegExp(`#/${scenario.id}/${String(scenario.steps.length)}$`));
    await expectKicker(page, scenario.steps.length, scenario.steps.length);
  }
});

test('6b. a table row appears when its packet is sent', async ({ page }) => {
  // A step with a packet that is sent after the step has started.
  const stepIndex = journey.steps.findIndex((step) => step.packets.some((p) => p.at > 0));
  await openApp(page, stepHash(JOURNEY, stepIndex + 1));

  const rows = packetTable(page).locator('tbody tr[data-current]');
  const before = await rows.count();

  await page.keyboard.press('=');
  await page.keyboard.press('=');
  await page.keyboard.press('Space');
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(before);
});

test('7b. switching views keeps the time, step and selected packet', async ({ page }) => {
  await openApp(page, stepHash(JOURNEY, 10));

  const timeline = page.getByRole('slider', { name: 'Timeline' });
  await packetTable(page).locator('tbody tr').nth(2).getByRole('cell').nth(1).click();

  const time = await timeline.inputValue();
  const stepText = await timeline.getAttribute('aria-valuetext');
  const selected = packetTable(page).locator('tbody tr[aria-current="true"]');
  await expect(selected).toHaveCount(1);

  await page.keyboard.press('v');
  await expect(page.locator('#view-panel-sequence')).toBeVisible();
  await expect(page.locator('[data-packet][data-selected="true"]')).toHaveCount(1);
  await expect(selected).toHaveCount(1);
  expect(await timeline.inputValue()).toBe(time);
  expect(await timeline.getAttribute('aria-valuetext')).toBe(stepText);

  await page.keyboard.press('v');
  await expect(page.locator('#view-panel-network')).toBeVisible();
  await expect(selected).toHaveCount(1);
  expect(await timeline.inputValue()).toBe(time);
});

test('8. "?" opens the shortcuts dialog and Esc closes it', async ({ page }) => {
  await openApp(page);

  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('table')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('9. packets jump between hop endpoints instead of gliding', async ({ page }) => {
    // The first step whose packet crosses a transit device and arrives.
    const stepIndex = journey.steps.findIndex((step) =>
      step.packets.some((p) => p.outcome === undefined && (p.via?.length ?? 0) >= 1),
    );
    expect(stepIndex).toBeGreaterThanOrEqual(0);

    await openApp(page, stepHash(JOURNEY, stepIndex + 1));
    await expect(sceneSvg(page)).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

    await page.keyboard.press('=');
    await page.keyboard.press('=');
    await page.keyboard.press('Space');
    await expect(pauseButton(page)).toBeVisible();

    const positions = await samplePacketPositions(page, 4000);

    const hopsById = new Map(
      (journey.steps[stepIndex]?.packets ?? []).map((p) => [p.id, (p.via?.length ?? 0) + 1]),
    );
    const observed = Object.entries(positions).filter(([id]) => hopsById.has(id));
    expect(observed.length).toBeGreaterThan(0);

    for (const [id, points] of observed) {
      const hops = hopsById.get(id) ?? 0;
      expect(
        points.length,
        `distinct positions of ${id} (${String(hops)} hops)`,
      ).toBeLessThanOrEqual(hops + 1);
    }
    // The packets did move, so the bound above is a real check.
    expect(Math.max(...observed.map(([, points]) => points.length))).toBeGreaterThan(1);
  });

  test('9b. there is no ambient animation, and the full mode has some', async ({ page }) => {
    // A step with a local action: its device pulses in full motion.
    const stepIndex = journey.steps.findIndex((step) => (step.actions?.length ?? 0) > 0);
    expect(stepIndex).toBeGreaterThanOrEqual(0);

    const runningAnimations = (): Promise<number> =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

    await openApp(page, stepHash(JOURNEY, stepIndex + 1));
    await page.keyboard.press('Space');
    await page.waitForTimeout(800);
    expect(await runningAnimations(), 'reduced motion').toBe(0);

    await page.getByRole('button', { name: 'Reduced motion' }).click();
    await expect(sceneSvg(page)).toHaveAttribute('data-motion', 'full');
    await expect.poll(runningAnimations).toBeGreaterThan(0);
  });

  test('10. the reduced-motion toggle reflects and persists the preference', async ({ page }) => {
    await openApp(page);

    const toggle = page.getByRole('button', { name: 'Reduced motion' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(sceneSvg(page)).toHaveAttribute('data-motion', 'full');
    expect(await page.evaluate(() => localStorage.getItem('nf.motion'))).toBe('full');

    await page.reload();
    await expect(sceneSvg(page)).toHaveAttribute('data-motion', 'full');
  });
});

test('11. without the reduced-motion preference packets glide between endpoints', async ({
  page,
}) => {
  const stepIndex = journey.steps.findIndex((step) =>
    step.packets.some((p) => p.outcome === undefined && (p.via?.length ?? 0) >= 1),
  );
  await openApp(page, stepHash(JOURNEY, stepIndex + 1));
  await expect(sceneSvg(page)).toHaveAttribute('data-motion', 'full');

  await page.keyboard.press('Space');
  await expect(pauseButton(page)).toBeVisible();

  const positions = await samplePacketPositions(page, 2500);
  const hopsById = new Map(
    (journey.steps[stepIndex]?.packets ?? []).map((p) => [p.id, (p.via?.length ?? 0) + 1]),
  );
  const mostPositions = Math.max(
    ...Object.entries(positions)
      .filter(([id]) => hopsById.has(id))
      .map(([, points]) => points.length),
  );

  expect(mostPositions).toBeGreaterThan(Math.max(...hopsById.values()) + 1);
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('12. the sidebar is a drawer, Details/Packets are tabs, nothing scrolls sideways', async ({
    page,
  }) => {
    await openApp(page, stepHash(JOURNEY, 10));

    const opener = page.locator('header').getByRole('button', { name: 'Open scenario list' });
    const app = page.locator('[data-nav-open]');
    await expect(opener).toBeVisible();
    await expect(app).toHaveAttribute('data-nav-open', 'false');

    await opener.click();
    await expect(app).toHaveAttribute('data-nav-open', 'true');
    await expect(
      page.getByRole('navigation', { name: 'Scenarios' }).getByRole('link').first(),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-nav-open', 'false');
    await expect(opener).toBeFocused();

    // Details and Packets are tabs here.
    const tabs = page.getByRole('tablist', { name: 'Details' });
    await expect(tabs.getByRole('tab', { name: 'Step' })).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: 'Packets' }).click();
    await expect(packetTable(page)).toBeVisible();
    await tabs.getByRole('tab', { name: 'Step' }).click();
    await expect(detailsPanel(page)).toBeVisible();

    for (const view of ['network', 'sequence']) {
      await page.goto(stepHash(JOURNEY, 10, view));
      await expect(page.locator(`#view-panel-${view}`)).toBeVisible();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth, `horizontal scroll in the ${view} view`).toBeLessThanOrEqual(
        overflow.innerWidth,
      );
    }
  });
});

test.describe('accessibility (axe)', () => {
  const viewports = [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
  ];

  // A step that sends a packet at once, so the inspector shows "(latest in this step)" without a click.
  const sendingStep = journey.steps.findIndex((step) => step.packets.some((p) => p.at === 0)) + 1;

  async function seriousViolations(page: Page): Promise<unknown[]> {
    // Let the panel cross-fade finish: axe contrast checks read the animated opacity.
    await page.waitForTimeout(500);

    const { violations } = await new AxeBuilder({ page }).analyze();

    return violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.map((n) => n.target.join(' ')),
      }));
  }

  for (const viewport of viewports) {
    for (const view of ['network', 'sequence']) {
      test(`13. no serious or critical violations: ${view} view at ${String(viewport.width)}x${String(viewport.height)}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await openApp(page, stepHash(JOURNEY, sendingStep, view));
        await expect(page.locator(`#view-panel-${view}`)).toBeVisible();

        // The default state: no packet chosen, the inspector follows the latest packet.
        expect(await seriousViolations(page), 'nothing selected').toEqual([]);

        // A chosen packet: selected glyph, highlighted row, inspector and expanded headers.
        if (viewport.width < 1024) {
          await page.getByRole('tab', { name: 'Packets' }).click();
        }
        const row = packetTable(page).locator('tbody tr').last();
        await row.getByRole('cell').nth(1).click();
        await row.getByRole('button', { name: /^Headers of packet/ }).click();
        expect(await seriousViolations(page), 'packet selected, row expanded').toEqual([]);
      });
    }
  }

  test('13. no serious or critical violations: drawer and shortcuts dialog', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await openApp(page, stepHash(JOURNEY, sendingStep));

    await page.locator('header').getByRole('button', { name: 'Open scenario list' }).click();
    expect(await seriousViolations(page), 'drawer open').toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations(page), 'shortcuts dialog open').toEqual([]);
  });
});

test('14. the scene stays within its DOM budget on the URL journey', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);

  const sceneElements = (): Promise<number> =>
    page.evaluate(
      () =>
        document.querySelector('svg[data-scenario]')?.parentElement?.querySelectorAll('*').length ??
        0,
    );

  let worst = 0;
  for (let step = 1; step <= journey.steps.length; step++) {
    await page.evaluate(
      (hash) => {
        location.hash = hash;
      },
      stepHash(JOURNEY, step),
    );
    await expectKicker(page, step);

    // Move into the step so its packets are on screen.
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    worst = Math.max(worst, await sceneElements());
  }

  expect(worst).toBeGreaterThan(0);
  expect(worst, 'scene DOM elements, worst step').toBeLessThanOrEqual(1500);
});

test('15. after the first load the app makes no network requests', async ({ page }) => {
  await openApp(page);
  await page.waitForLoadState('networkidle');

  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });

  // Walk through scenarios, steps, views, panels and playback.
  await page.keyboard.press('v');
  await page.keyboard.press('v');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  for (const scenario of scenarios.slice(1, 4)) {
    await page.evaluate(
      (hash) => {
        location.hash = hash;
      },
      stepHash(scenario.id, 2),
    );
    await expectKicker(page, 2);
  }
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  expect(requests).toEqual([]);
});
