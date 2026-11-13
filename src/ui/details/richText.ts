/** The only inline formatting scenario text may use: `code` and **bold**. */
export type RichNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; children: RichNode[] };

/**
 * Parses inline `code` and **bold** without any markup library or HTML. Code is literal (no nesting),
 * bold may contain code. An unclosed marker stays literal text. Everything else is plain text, so the
 * result can be rendered as React nodes safely.
 */
export function parseRichText(input: string, allowBold = true): RichNode[] {
  const nodes: RichNode[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer !== '') {
      nodes.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  while (i < input.length) {
    if (input[i] === '`') {
      const end = input.indexOf('`', i + 1);

      if (end > i + 1) {
        flush();
        nodes.push({ kind: 'code', text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (allowBold && input.startsWith('**', i)) {
      const end = findBoldEnd(input, i + 2);

      if (end > i + 2) {
        flush();
        nodes.push({ kind: 'bold', children: parseRichText(input.slice(i + 2, end), false) });
        i = end + 2;
        continue;
      }
    }

    buffer += input.charAt(i);
    i++;
  }

  flush();

  return nodes;
}

/** Index of the closing `**`, skipping over code spans; -1 when there is none. */
function findBoldEnd(input: string, from: number): number {
  let i = from;

  while (i < input.length) {
    if (input[i] === '`') {
      const end = input.indexOf('`', i + 1);

      if (end > i) {
        i = end + 1;
        continue;
      }
    }

    if (input.startsWith('**', i)) {
      return i;
    }

    i++;
  }

  return -1;
}
