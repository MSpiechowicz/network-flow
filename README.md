# Network Flow

Interactive, animated explanations of how the internet works. Pick a scenario (the journey of a URL,
TCP, UDP, IP, DHCP, DNS, HTTP and HTTPS, TLS, CORS, CDNs, email) and step through it. Each step shows the
packets crossing an isometric network, the same moment as a sequence diagram, a Wireshark-style packet
table and the header fields of any packet you select.

Everything runs in the browser from static files. There is no backend, no account and no analytics, and
after the first load the app makes no network requests. Addresses, names and ports in the scenarios are
documentation values (RFC 5737, RFC 1918, RFC 2606), so nothing points at a real host except the DNS root
and `.com` servers that the DNS steps name.

## Using the app

- Pick a scenario in the sidebar and click a step, or press play. Playback runs through
  the steps; turn "Pause each step" on to stop at the end of every step.
- **Network** and **Sequence** show the same moment; switching keeps the time, step and selected packet.
- Click a packet in the scene, an arrow in the sequence diagram or a table row to select it and see its
  headers.
- The address bar holds the state: `#/<scenario>/<step>?view=sequence`. Copy it to share a spot.
- On screens narrower than 1024 px the sidebar becomes a drawer, Step and Packets become tabs, and
  the page scrolls as a whole; below 640 px the controls stack into rows.
- "Reduced motion" (also the default when your system asks for it) makes packets jump between devices
  and turns off ambient animation. Press `?` for all keyboard shortcuts.

| Keys                              | Action                     |
| --------------------------------- | -------------------------- |
| Space or K                        | Play or pause              |
| Right arrow or L, Left arrow or J | Next step, previous step   |
| Shift + arrows                    | Seek 1 second              |
| Home, End                         | First, last step           |
| `-`, `=`                          | Slower, faster             |
| V                                 | Switch view                |
| `?`                               | Shortcuts dialog           |
| Esc                               | Close the dialog or drawer |

## Requirements

Node 26 and pnpm 11 (`corepack enable`, or install pnpm directly).

```sh
pnpm install
pnpm dev
```

## Scripts

| Script           | What it does                                                                 |
| ---------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`       | Vite dev server                                                              |
| `pnpm build`     | Typecheck, then build to `dist/` (relative base, so it works under any path) |
| `pnpm preview`   | Serve the build                                                              |
| `pnpm typecheck` | `tsc -b`                                                                     |
| `pnpm lint`      | ESLint, zero warnings allowed                                                |
| `pnpm test`      | Vitest unit tests, including the validator over every scenario               |
| `pnpm test:e2e`  | Playwright smoke test in Chromium (not part of `check`)                      |
| `pnpm check`     | Typecheck, lint, unit tests and build                                        |
| `pnpm format`    | Prettier                                                                     |

### Tests

- `pnpm test` covers the playback engine, routing, sequence layout, formatting and the scenario
  validator. The validator checks every file in `src/scenarios/data/`, including technical accuracy
  (addresses, TCP sequence numbers, IP fragments), so a new scenario is checked without writing a test.
- `pnpm test:e2e` builds the app, serves it with `vite preview` on port 4173 and drives it in Chromium:
  the deep link, sidebar, keyboard, views, packet table, reduced motion, the tablet layout, an axe
  accessibility scan of both views, the scene's DOM budget, and a check that nothing leaves the origin
  and nothing logs an error. Install the browser once with `pnpm exec playwright install chromium`.
  An already running server on port 4173 is reused, so stop it first if you changed the code.

## Deploying

`pnpm build` writes a fully static site to `dist/`. Asset paths are relative and navigation uses the
URL hash, so the folder can be served from any static host and under any sub-path, including GitHub
Pages project sites (`https://<user>.github.io/<repo>/`). Publish the contents of `dist/`; no server
configuration or rewrite rules are needed.

This repository deploys itself: `.github/workflows/pages.yml` runs `pnpm check` on every push to
`main` and publishes `dist/` to GitHub Pages. It needs Pages set to "GitHub Actions" once, under
Settings → Pages → Build and deployment → Source.

## Structure

```
src/
  app/          App shell, hash routing, keyboard shortcuts, motion preference
  engine/       Pure playback engine: compile a scenario to a timeline, reducer, selectors,
                isometric geometry, and the store hooks (store.ts, useClock.ts)
  model/        types.ts: the scenario data model
  protocols/    Registries: protocols (colours, layers) and node kinds
  scenarios/    data/ (one file per scenario), lib/ (builders, shared addresses),
                checks/ and validate.ts (the validator), __fixtures__/
  ui/           scene/ (network view), sequence/ (sequence view), sidebar/, details/,
                packets/, controls/, common/
  styles/       tokens.css (colours, spacing, protocol colours) and global.css
e2e/            Playwright smoke test
docs/           authoring-scenarios.md
```

Packet positions are pure functions of one clock, so scrubbing, stepping back and deep links are
deterministic. Only the packet layer, the playhead and the elapsed-time readout update every frame.

## Adding a scenario

A scenario is one TypeScript file in `src/scenarios/data/`; a new protocol or node kind is an entry in a
registry. See [docs/authoring-scenarios.md](docs/authoring-scenarios.md) for the data model, the
validator's error codes, layout guidance and the accuracy guardrails.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE). The runtime dependencies are MIT or 0BSD licensed
(`pnpm licenses list --prod`). The interface and all text are original.
