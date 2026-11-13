import type { NodeKind } from '../../../protocols/nodeKinds';

/**
 * Accent tint per node kind. Hex values mirror `--kind-<id>` in `src/styles/tokens.css`.
 * Kinds that share the server rack get clearly different hues so two of them in one scene
 * (resolver beside authoritative server) never read as the same machine.
 */
export const KIND_TINT: Record<NodeKind, string> = {
  laptop: '#c8f169',
  phone: '#c8f169',
  router: '#5fd4e8',
  switch: '#7b8cff',
  firewall: '#ff7a5c',
  cloud: '#7fc4ff',
  'dns-resolver': '#38bdf8',
  'dns-root': '#e6ebf5',
  'dns-tld': '#5d68ff',
  'dns-authoritative': '#b79cff',
  'cdn-edge': '#3fd9a0',
  'origin-server': '#f6b94c',
  'api-server': '#ff7f73',
  'dhcp-server': '#b4e33d',
  'mail-server': '#ff9a62',
  observer: '#ff5c7a',
  server: '#8b98b5',
};
