/**
 * Component tests for the shadcn/ui form & input primitives added for
 * AC 12 Sub-AC 2.
 *
 * Scope: render each primitive in isolation and assert the shadcn-style
 * contract — variant/size class recipes, `ref` forwarding, data-attribute
 * hooks, and the `cn()`-driven `className` override slot. These tests
 * protect against accidental regressions when the underlying Tailwind
 * tokens are tweaked.
 *
 * Runner: Vitest + jsdom + @testing-library/react.
 * Command: `pnpm test:spa`
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { Badge, badgeVariants } from './badge.jsx';
import { Button, buttonVariants } from './button.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card.jsx';
import { Input } from './input.jsx';
import { Label } from './label.jsx';
import { Textarea } from './textarea.jsx';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('renders a native <button> with type="button" and the default variant', () => {
    const { container } = render(<Button>Save</Button>);
    const btn = container.querySelector('[data-component="button"]');
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveAttribute('data-variant', 'primary');
    expect(btn).toHaveAttribute('data-size', 'default');
    expect(btn).toHaveTextContent('Save');
  });

  it('honours variant + size props and composes caller className last', () => {
    const { container } = render(
      <Button variant="destructive" size="sm" className="shadow-xl">
        Delete
      </Button>,
    );
    const btn = container.querySelector('[data-component="button"]');
    expect(btn).toHaveAttribute('data-variant', 'destructive');
    expect(btn).toHaveAttribute('data-size', 'sm');
    expect(btn.className).toContain('shadow-xl');
    // Base + variant tokens must coexist.
    expect(btn.className).toContain('inline-flex');
    expect(btn.className).toContain('bg-red-500/90');
  });

  it('forwards refs to the underlying DOM node', () => {
    const ref = React.createRef();
    render(<Button ref={ref}>Ref me</Button>);
    expect(ref.current).not.toBeNull();
    expect(ref.current.tagName).toBe('BUTTON');
  });

  it('buttonVariants returns a class string containing base + variant + size tokens', () => {
    const cls = buttonVariants({
      variant: 'outline',
      size: 'lg',
      className: 'mt-2',
    });
    expect(cls).toContain('inline-flex');
    expect(cls).toContain('border-slate-700');
    expect(cls).toContain('h-10');
    expect(cls).toContain('mt-2');
  });

  it('buttonVariants falls back to the primary/default recipe on unknown values', () => {
    const cls = buttonVariants({ variant: 'bogus', size: 'nope' });
    expect(cls).toContain('bg-sky-500/90'); // primary
    expect(cls).toContain('h-9'); // default
  });
});

describe('Input', () => {
  it('renders a text input with the shadcn base classes', () => {
    const { container } = render(<Input placeholder="Search" />);
    const input = container.querySelector('[data-component="input"]');
    expect(input).not.toBeNull();
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('placeholder', 'Search');
    expect(input.className).toContain('rounded-md');
    expect(input.className).toContain('border-slate-700');
  });

  it('forwards custom type + className + aria-invalid', () => {
    const { container } = render(
      <Input type="email" aria-invalid="true" className="tracking-tight" />,
    );
    const input = container.querySelector('[data-component="input"]');
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.className).toContain('tracking-tight');
  });

  it('forwards refs', () => {
    const ref = React.createRef();
    render(<Input ref={ref} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current.tagName).toBe('INPUT');
  });
});

describe('Textarea', () => {
  it('renders a textarea with the shadcn base classes', () => {
    const { container } = render(<Textarea rows={4} placeholder="Goal" />);
    const ta = container.querySelector('[data-component="textarea"]');
    expect(ta).not.toBeNull();
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta).toHaveAttribute('rows', '4');
    expect(ta).toHaveAttribute('placeholder', 'Goal');
    expect(ta.className).toContain('min-h-[72px]');
  });

  it('forwards refs', () => {
    const ref = React.createRef();
    render(<Textarea ref={ref} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current.tagName).toBe('TEXTAREA');
  });
});

describe('Label', () => {
  it('renders a native <label> with htmlFor forwarded', () => {
    const { container } = render(<Label htmlFor="slug">Agent slug</Label>);
    const label = container.querySelector('[data-component="label"]');
    expect(label).not.toBeNull();
    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', 'slug');
    expect(label).toHaveTextContent('Agent slug');
    expect(label.className).toContain('font-medium');
  });

  it('pairs with Input via shared id/htmlFor', () => {
    const { container } = render(
      <>
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" />
      </>,
    );
    const label = container.querySelector('[data-component="label"]');
    const input = container.querySelector('[data-component="input"]');
    expect(label.getAttribute('for')).toBe(input.getAttribute('id'));
  });
});

describe('Card family', () => {
  it('renders the full composition with the expected data-attributes', () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>alice</CardTitle>
          <CardDescription>Scheduled Claude Code agent</CardDescription>
        </CardHeader>
        <CardContent>
          <p>Body</p>
        </CardContent>
        <CardFooter>
          <Button>Save</Button>
        </CardFooter>
      </Card>,
    );
    expect(container.querySelector('[data-component="card"]')).not.toBeNull();
    expect(
      container.querySelector('[data-component="card-header"]'),
    ).not.toBeNull();
    const title = container.querySelector('[data-component="card-title"]');
    expect(title).not.toBeNull();
    expect(title.tagName).toBe('H3');
    expect(title).toHaveTextContent('alice');
    expect(
      container.querySelector('[data-component="card-description"]'),
    ).toHaveTextContent('Scheduled Claude Code agent');
    expect(
      container.querySelector('[data-component="card-content"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-component="card-footer"]'),
    ).not.toBeNull();
  });

  it('CardTitle supports the `as` prop for heading level overrides', () => {
    const { container } = render(<CardTitle as="h2">Dashboard</CardTitle>);
    const title = container.querySelector('[data-component="card-title"]');
    expect(title.tagName).toBe('H2');
  });

  it('composes caller className last so overrides win', () => {
    const { container } = render(<Card className="bg-emerald-500/10" />);
    const card = container.querySelector('[data-component="card"]');
    expect(card.className).toContain('bg-emerald-500/10');
    expect(card.className).toContain('rounded-lg');
  });
});

describe('Badge', () => {
  it('renders a <span> with the default variant class recipe', () => {
    const { container } = render(<Badge>Active</Badge>);
    const badge = container.querySelector('[data-component="badge"]');
    expect(badge).not.toBeNull();
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveAttribute('data-variant', 'default');
    expect(badge).toHaveTextContent('Active');
    expect(badge.className).toContain('rounded-full');
    expect(badge.className).toContain('bg-sky-500/10');
  });

  it('switches tone via the variant prop', () => {
    const { container } = render(<Badge variant="success">Healthy</Badge>);
    const badge = container.querySelector('[data-component="badge"]');
    expect(badge).toHaveAttribute('data-variant', 'success');
    expect(badge.className).toContain('bg-emerald-500/10');
  });

  it('badgeVariants returns a class string for a given variant', () => {
    expect(badgeVariants({ variant: 'warning' })).toContain('bg-amber-500/10');
    expect(badgeVariants({ variant: 'destructive' })).toContain(
      'bg-red-500/10',
    );
    expect(badgeVariants({ variant: 'bogus' })).toContain('bg-sky-500/10');
  });
});
