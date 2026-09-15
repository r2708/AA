import { assert, expectUnavailable, run } from '../helpers/harness';
import {
  createAsyncAwait,
  createDefaultExport,
  createDefaultImport,
  createDestructuring,
  createExport,
  createImport,
  createNamedImport,
  createNullishCoalescing,
  createOptionalChaining,
  createPromise,
  createReExport,
  createSpread,
} from '../../src/commands/imports/importCommands';

describe('import / export commands', () => {
  it('imports a known React symbol and merges into the existing import', async () => {
    const { text } = await run(
      createImport,
      `import { useState } from 'react';\n\nfunction App() {\n  const ref = [[useRef]](null);\n}`,
    );
    assert.ok(text.startsWith(`import { useState, useRef } from 'react';`), text);
  });

  it('does not duplicate an existing import', () => {
    const reason = expectUnavailable(
      createImport,
      `import { useState } from 'react';\nconst s = [[useState]];`,
    );
    assert.ok(/already imported/.test(reason), reason);
  });

  it('adds a Node builtin import after the last import', async () => {
    const { text } = await run(
      createImport,
      `import a from 'a';\nimport b from 'b';\n\nconst p = [[join]]('x');`,
    );
    assert.strictEqual(
      text,
      `import a from 'a';\nimport b from 'b';\nimport { join } from 'node:path';\n\nconst p = join('x');`,
    );
  });

  it('only offers dependency-based symbols when the dependency exists', async () => {
    const without = await run(createImport, `const r = [[Router]]();`);
    assert.ok(without.text.startsWith(`import { Router } from 'module';`), without.text);
    const withDep = await run(createImport, `const r = [[Router]]();`, {
      project: { dependencies: ['express'] },
    });
    assert.ok(withDep.text.startsWith(`import { Router } from 'express';`), withDep.text);
  });

  it('inserts named and default import snippets after a use client directive', async () => {
    const named = await run(createNamedImport, `'use client';\n\nconst x = 1;<|>`);
    assert.strictEqual(named.text, `'use client';\n\nimport { name } from 'module';\n\nconst x = 1;`);
    const def = await run(createDefaultImport, `<|>`);
    assert.strictEqual(def.text, `import name from 'module';\n`);
  });

  it('respects double quotes and missing semicolons', async () => {
    const { text } = await run(createImport, `import a from "a"\nconst b = "x"\nconst p = [[join]]("x")`);
    assert.ok(text.startsWith(`import a from "a"\nimport { join } from "node:path"\n`), text);
  });

  it('exports the declaration at the cursor once', async () => {
    const { text } = await run(createExport, `function he<|>lp() {}`);
    assert.strictEqual(text, `export function help() {}`);
    expectUnavailable(createExport, `export function he<|>lp() {}`);
  });

  it('creates a default export and refuses a second one', async () => {
    const fn = await run(createDefaultExport, `export function A<|>pp() {}`);
    assert.strictEqual(fn.text, `export default function App() {}`);
    const variable = await run(createDefaultExport, `const con<|>fig = {};\n`);
    assert.strictEqual(variable.text, `const config = {};\n\nexport default config;\n`);
    expectUnavailable(createDefaultExport, `export default function A() {}\nfunction B<|>() {}`);
  });

  it('adds a re-export for a selected import', async () => {
    const { text } = await run(createReExport, `[[import { a, b as c } from './m';]]`);
    assert.strictEqual(text, `import { a, b as c } from './m';\nexport { a, b as c } from './m';`);
  });

  it('destructures using the known interface members', async () => {
    const { text } = await run(
      createDestructuring,
      `interface User { id: string; name: string }\nfunction f(user: User) {\n  [[user]];\n}`,
    );
    assert.strictEqual(
      text,
      `interface User { id: string; name: string }\nfunction f(user: User) {\n  const { id, name } = user;\n}`,
    );
  });

  it('destructures an object literal variable', async () => {
    const { text } = await run(createDestructuring, `const config = { host: 'x', port: 1 };\n[[config]];`);
    assert.ok(text.endsWith(`const { host, port } = config;`), text);
  });

  it('spreads arrays and objects appropriately', async () => {
    const arr = await run(createSpread, `const items = [1];\nconst copy = [[items]];`);
    assert.strictEqual(arr.text, `const items = [1];\nconst copy = [...items];`);
    const obj = await run(createSpread, `const config = { a: 1 };\nconst copy = [[config]];`);
    assert.strictEqual(obj.text, `const config = { a: 1 };\nconst copy = { ...config };`);
  });

  it('rewrites member chains with optional chaining', async () => {
    const sel = await run(createOptionalChaining, `const n = [[user.profile.name]];`);
    assert.strictEqual(sel.text, `const n = user?.profile?.name;`);
    const cursor = await run(createOptionalChaining, `const n = this.user.pro<|>file.getName();`);
    assert.strictEqual(cursor.text, `const n = this.user?.profile?.getName();`);
    expectUnavailable(createOptionalChaining, `const n = [[user?.name]];`);
  });

  it('converts || into ?? and appends fallbacks', async () => {
    const conv = await run(createNullishCoalescing, `const n = [[a || b]];`);
    assert.strictEqual(conv.text, `const n = a ?? b;`);
    const fb = await run(createNullishCoalescing, `const n = [[user.name]];`);
    assert.strictEqual(fb.text, `const n = user.name ?? fallback;`);
  });

  it('combines independent awaits into Promise.all', async () => {
    const { text } = await run(
      createPromise,
      `async function f() {\n[[  const a = await loadA();\n  const b = await loadB();\n]]  return a + b;\n}`,
    );
    assert.strictEqual(
      text,
      `async function f() {\n  const [a, b] = await Promise.all([loadA(), loadB()]);\n  return a + b;\n}`,
    );
  });

  it('does not combine dependent awaits', async () => {
    const { text } = await run(
      createPromise,
      `async function f() {\n[[  const a = await loadA();\n  const b = await loadB(a);\n]]}`,
    );
    assert.ok(!text.includes('Promise.all'), text);
    assert.ok(text.includes('await new Promise<void>((resolve, reject) => {'), text);
  });

  it('converts .then() to await and marks the function async', async () => {
    const { text } = await run(
      createAsyncAwait,
      `function load() {\n  [[fetchUser().then((user) => {\n    console.log(user);\n  });]]\n}`,
    );
    assert.strictEqual(
      text,
      `async function load() {\n  const user = await fetchUser();\n  console.log(user);\n}`,
    );
  });

  it('awaits a selected expression and makes an arrow function async', async () => {
    const { text } = await run(createAsyncAwait, `const load = () => {\n  const r = [[fetch(url)]];\n};`);
    assert.strictEqual(text, `const load = async () => {\n  const r = await fetch(url);\n};`);
  });

  it('marks a method async and refuses when already async', async () => {
    const { text } = await run(createAsyncAwait, `class A {\n  load() {\n    <|>\n  }\n}`);
    assert.ok(text.includes('  async load() {'), text);
    expectUnavailable(createAsyncAwait, `async function f() {\n  <|>\n}`);
  });
});
