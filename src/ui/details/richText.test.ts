import { describe, expect, it } from 'vitest';
import { parseRichText } from './richText';

describe('parseRichText', () => {
  it('returns plain text unchanged', () => {
    expect(parseRichText('just words')).toEqual([{ kind: 'text', text: 'just words' }]);
  });

  it('parses inline code and bold', () => {
    expect(parseRichText('Send `SYN` with **ISN** now')).toEqual([
      { kind: 'text', text: 'Send ' },
      { kind: 'code', text: 'SYN' },
      { kind: 'text', text: ' with ' },
      { kind: 'bold', children: [{ kind: 'text', text: 'ISN' }] },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('keeps asterisks inside code literal', () => {
    expect(parseRichText('`a**b**c`')).toEqual([{ kind: 'code', text: 'a**b**c' }]);
  });

  it('allows code inside bold', () => {
    expect(parseRichText('**the `Host` header**')).toEqual([
      {
        kind: 'bold',
        children: [
          { kind: 'text', text: 'the ' },
          { kind: 'code', text: 'Host' },
          { kind: 'text', text: ' header' },
        ],
      },
    ]);
  });

  it('leaves unclosed markers as literal text', () => {
    expect(parseRichText('a `b and **c')).toEqual([{ kind: 'text', text: 'a `b and **c' }]);
  });

  it('never produces markup: HTML stays plain text', () => {
    expect(parseRichText('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});
