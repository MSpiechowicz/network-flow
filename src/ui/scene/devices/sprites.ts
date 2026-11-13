import type { ComponentType } from 'react';
import type { SpriteId } from '../../../protocols/nodeKinds';
import { bounds as cdnEdgeBounds, CdnEdge } from './CdnEdge';
import { bounds as cloudBounds, Cloud } from './Cloud';
import { bounds as firewallBounds, Firewall } from './Firewall';
import type { SpriteBounds } from './iso';
import { bounds as laptopBounds, Laptop } from './Laptop';
import { bounds as mailServerBounds, MailServer } from './MailServer';
import { bounds as observerBounds, Observer } from './Observer';
import { bounds as phoneBounds, Phone } from './Phone';
import { bounds as routerBounds, Router } from './Router';
import { bounds as serverBounds, ServerRack } from './ServerRack';
import { bounds as switchBounds, Switch } from './Switch';
import type { SpriteProps } from './types';

export interface SpriteEntry {
  Component: ComponentType<SpriteProps>;
  /** Bounds of the default look. Server kinds with a custom rack shape use `kindBounds`. */
  bounds: SpriteBounds;
}

/** Every dedicated sprite by `SpriteId`. The `server` entry is also the fallback rack. */
export const SPRITES: Record<SpriteId, SpriteEntry> = {
  laptop: { Component: Laptop, bounds: laptopBounds },
  phone: { Component: Phone, bounds: phoneBounds },
  router: { Component: Router, bounds: routerBounds },
  switch: { Component: Switch, bounds: switchBounds },
  firewall: { Component: Firewall, bounds: firewallBounds },
  cloud: { Component: Cloud, bounds: cloudBounds },
  server: { Component: ServerRack, bounds: serverBounds },
  'cdn-edge': { Component: CdnEdge, bounds: cdnEdgeBounds },
  'mail-server': { Component: MailServer, bounds: mailServerBounds },
  observer: { Component: Observer, bounds: observerBounds },
};
