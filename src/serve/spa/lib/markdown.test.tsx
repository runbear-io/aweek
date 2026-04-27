/**
 * Unit tests for the shared `<Markdown>` component.
 *
 * Covers: headings, lists, bold, inline code, GFM task lists,
 * GFM tables, external links (target=_blank).
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { Markdown } from './markdown.js';

afterEach(cleanup);

describe('Markdown — headings', () => {
  it('renders h1 through h4', () => {
    const { container } = render(
      <Markdown source={'# H1\n## H2\n### H3\n#### H4'} />,
    );
    expect(container.querySelector('h1')).toHaveTextContent('H1');
    expect(container.querySelector('h2')).toHaveTextContent('H2');
    expect(container.querySelector('h3')).toHaveTextContent('H3');
    expect(container.querySelector('h4')).toHaveTextContent('H4');
  });
});

describe('Markdown — lists', () => {
  it('renders an unordered list', () => {
    const { container } = render(
      <Markdown source={'- Apple\n- Banana\n- Cherry'} />,
    );
    const items = Array.from(container.querySelectorAll('ul li')).map(
      (li) => li.textContent,
    );
    expect(items).toEqual(['Apple', 'Banana', 'Cherry']);
  });

  it('renders an ordered list', () => {
    const { container } = render(
      <Markdown source={'1. First\n2. Second\n3. Third'} />,
    );
    const items = Array.from(container.querySelectorAll('ol li')).map(
      (li) => li.textContent,
    );
    expect(items).toEqual(['First', 'Second', 'Third']);
  });
});

describe('Markdown — inline emphasis', () => {
  it('renders **bold** as <strong>', () => {
    const { container } = render(<Markdown source="**bold text**" />);
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent('bold text');
    expect(strong).toHaveClass('font-semibold');
  });

  it('renders _italic_ as <em>', () => {
    const { container } = render(<Markdown source="_italic text_" />);
    expect(container.querySelector('em')).toHaveTextContent('italic text');
  });
});

describe('Markdown — inline code', () => {
  it('renders `inline code` with mono styling', () => {
    const { container } = render(<Markdown source="Use `npm install`." />);
    const code = container.querySelector('p code');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('npm install');
    expect(code?.className).toMatch(/font-mono/);
  });
});

describe('Markdown — GFM task list', () => {
  it('renders checked and unchecked task items with disabled checkboxes', () => {
    const source = '- [x] Done\n- [ ] Todo';
    const { container } = render(<Markdown source={source} />);
    const checkboxes = Array.from(
      container.querySelectorAll('input[type="checkbox"]'),
    ) as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]?.checked).toBe(true);
    expect(checkboxes[1]?.checked).toBe(false);
    // All checkboxes must be disabled (read-only rendering).
    checkboxes.forEach((cb) => expect(cb.disabled).toBe(true));
  });
});

describe('Markdown — GFM table', () => {
  it('renders a markdown table as <table> with th and td cells', () => {
    const source = '| Col1 | Col2 |\n|------|------|\n| a | b |';
    const { container } = render(<Markdown source={source} />);
    expect(container.querySelector('table')).not.toBeNull();
    const headers = Array.from(container.querySelectorAll('th')).map(
      (th) => th.textContent?.trim(),
    );
    expect(headers).toEqual(['Col1', 'Col2']);
    const cells = Array.from(container.querySelectorAll('td')).map(
      (td) => td.textContent?.trim(),
    );
    expect(cells).toEqual(['a', 'b']);
  });
});

describe('Markdown — links', () => {
  it('renders an external link with target=_blank and rel=noopener noreferrer', () => {
    const { container } = render(
      <Markdown source="[Visit](https://example.com)" />,
    );
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveTextContent('Visit');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders an internal link without target=_blank', () => {
    const { container } = render(<Markdown source="[Home](/home)" />);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('target')).toBeNull();
  });
});
