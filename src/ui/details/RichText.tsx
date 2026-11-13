import type { ReactNode } from 'react';
import { parseRichText } from './richText';
import type { RichNode } from './richText';

function renderNodes(nodes: readonly RichNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'bold':
        return <strong key={index}>{renderNodes(node.children)}</strong>;
    }
  });
}

/** Renders scenario `RichText` (inline `code` and **bold**) as React nodes. */
export function RichText({ text }: { text: string }) {
  return <>{renderNodes(parseRichText(text))}</>;
}
