import { assert, expectUnavailable, run } from '../helpers/harness';
import {
  createCustomHook,
  createEventHandler,
  createJsxElement,
  createPropsInterface,
  createReactComponent,
  createReactContext,
  createReactHook,
  createUseCallback,
  createUseEffect,
  createUseMemo,
  createUseRef,
  createUseState,
} from '../../src/commands/react/reactCommands';

const TSX = { languageId: 'typescriptreact' as const };

describe('React commands', () => {
  it('creates a component named after the file with a props interface', async () => {
    const { text } = await run(createReactComponent, `<|>`, { ...TSX, fileName: '/p/src/UserCard.tsx' });
    assert.ok(text.includes('interface UserCardProps {'), text);
    assert.ok(
      text.includes(
        'export default function UserCard(props: UserCardProps) {\n  return (\n    <div>\n      \n    </div>\n  );\n}',
      ),
      text,
    );
  });

  it('extracts selected JSX into a component with inferred props', async () => {
    const { text } = await run(
      createReactComponent,
      `function List({ items }: { items: string[] }) {\n  const title = 'x';\n  return (\n    <div>\n      [[<header className="list-header"><h1>{title}</h1><span>{items.length}</span></header>]]\n    </div>\n  );\n}\n`,
      TSX,
    );
    assert.ok(text.includes('<ListHeader title={title} items={items} />'), text);
    assert.ok(text.includes('interface ListHeaderProps {\n  title: string;\n  items: string[];\n}'), text);
    assert.ok(
      text.includes(
        'function ListHeader({ title, items }: ListHeaderProps) {\n  return (\n    <header className="list-header"><h1>{title}</h1><span>{items.length}</span></header>\n  );\n}',
      ),
      text,
    );
  });

  it('adds useState after existing hooks and merges the import', async () => {
    const { text } = await run(
      createUseState,
      `import { useEffect } from 'react';\n\nexport function App(<|>) {\n  useEffect(() => {}, []);\n  return <div />;\n}`,
      TSX,
    );
    assert.ok(text.startsWith(`import { useEffect, useState } from 'react';`), text);
    assert.ok(
      text.includes(
        `  useEffect(() => {}, []);\n  const [value, setValue] = useState<string>('');\n  return <div />;`,
      ),
      text,
    );
  });

  it('types useState from a selected initial value and reuses the existing import', async () => {
    const { text } = await run(
      createUseState,
      `import { useState } from 'react';\nfunction App() {\n  [[0]];\n  return null;\n}`,
      TSX,
    );
    assert.strictEqual(
      text,
      `import { useState } from 'react';\nfunction App() {\n  const [count, setCount] = useState<number>(0);\n  return null;\n}`,
    );
  });

  it('refuses hooks outside components', () => {
    const reason = expectUnavailable(createUseState, `function helper() {\n  <|>\n}`, TSX);
    assert.ok(/component or a custom hook/.test(reason));
  });

  it('wraps statements in useEffect with inferred dependencies', async () => {
    const { text } = await run(
      createUseEffect,
      `import { useState } from 'react';\nfunction App({ id }: { id: string }) {\n  const [data, setData] = useState(null);\n[[  document.title = id;\n  console.log(data);\n]]  return null;\n}`,
      TSX,
    );
    assert.ok(
      text.includes(
        `  useEffect(() => {\n    document.title = id;\n    console.log(data);\n  }, [id, data]);`,
      ),
      text,
    );
    assert.ok(text.startsWith(`import { useState, useEffect } from 'react';`), text);
  });

  it('memoizes an initializer with useMemo and inferred deps', async () => {
    const { text } = await run(
      createUseMemo,
      `function App({ items }: { items: number[] }) {\n  const total = [[items.reduce((a, b) => a + b, 0)]];\n  return null;\n}`,
      TSX,
    );
    assert.ok(text.includes(`const total = useMemo(() => items.reduce((a, b) => a + b, 0), [items]);`), text);
    assert.ok(text.startsWith(`import { useMemo } from 'react';\n\n`), text);
  });

  it('wraps the enclosing arrow function in useCallback', async () => {
    const { text } = await run(
      createUseCallback,
      `function App({ onSave }: { onSave: () => void }) {\n  const handle = () => {\n    onSa<|>ve();\n  };\n  return null;\n}`,
      TSX,
    );
    assert.ok(text.includes(`const handle = useCallback(() => {\n    onSave();\n  }, [onSave]);`), text);
  });

  it('creates and attaches an element ref from the JSX tag', async () => {
    const { text } = await run(createUseRef, `function App() {\n  return <input ty<|>pe="text" />;\n}`, TSX);
    assert.ok(text.includes('const inputRef = useRef<HTMLInputElement>(null);'), text);
    assert.ok(text.includes('<input ref={inputRef} type="text" />'), text);
  });

  it('creates a context with provider and hook', async () => {
    const { text } = await run(createReactContext, `<|>`, { ...TSX, fileName: '/p/src/theme-context.tsx' });
    assert.ok(
      text.includes('const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);'),
      text,
    );
    assert.ok(text.includes('export function ThemeProvider({ children }: { children: ReactNode })'), text);
    assert.ok(text.includes('export function useTheme() {'), text);
    assert.ok(text.includes(`import { createContext, useContext } from 'react';`), text);
    assert.ok(text.includes(`import type { ReactNode } from 'react';`), text);
  });

  it('extracts hook-using statements into a custom hook', async () => {
    const { text } = await run(
      createCustomHook,
      `import { useState, useEffect } from 'react';\nfunction App({ url }: { url: string }) {\n[[  const [data, setData] = useState(null);\n  useEffect(() => { fetch(url).then((r) => r.json()).then(setData); }, [url]);\n]]  return <div>{data}</div>;\n}`,
      TSX,
    );
    assert.ok(text.includes('  const data = useData(url);\n  return <div>{data}</div>;'), text);
    assert.ok(text.includes('  return data;\n}'), text);
    assert.ok(text.includes('function useData(url: string) {'), text);
  });

  it('generates a props interface from destructured props and usage', async () => {
    const { text } = await run(
      createPropsInterface,
      `function Card({ title, count, onClose, children }) {\n  const label = title.toUpperCase();\n  const next = count * 2;\n  return <div onClick={onClose}>{children}<|></div>;\n}`,
      TSX,
    );
    assert.ok(
      text.includes(
        'interface CardProps {\n  title: string;\n  count: number;\n  onClose: () => void;\n  children: ReactNode;\n}',
      ),
      text,
    );
    assert.ok(text.includes('function Card({ title, count, onClose, children }: CardProps) {'), text);
    assert.ok(text.includes(`import type { ReactNode } from 'react';`), text);
  });

  it('creates a typed event handler for the attribute at the cursor', async () => {
    const { text } = await run(
      createEventHandler,
      `import React from 'react';\nfunction Form() {\n  return <form onSub<|>mit><button>Go</button></form>;\n}`,
      TSX,
    );
    assert.ok(
      text.includes(
        '  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {\n    event.preventDefault();\n    \n  };\n\n  return <form onSubmit={handleSubmit}>',
      ),
      text,
    );
  });

  it('wraps selected JSX in an element', async () => {
    const { text } = await run(createJsxElement, `const el = [[<span>hi</span>]];`, TSX);
    assert.strictEqual(text, `const el = <div><span>hi</span></div>;`);
  });

  it('offers hooks through the chooser', async () => {
    const { text, ui } = await run(createReactHook, `function App() {\n  <|>\n  return null;\n}`, {
      ...TSX,
      picks: ['useRef'],
    });
    assert.ok(ui.asked[0].labels?.includes('useState'));
    assert.ok(text.includes('const ref = useRef<HTMLDivElement>(null);'), text);
  });

  it('is unavailable in non-React files', () => {
    expectUnavailable(createUseState, `function f() {\n  <|>\n}`);
    expectUnavailable(createReactComponent, `<|>`);
  });
});
