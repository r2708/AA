import { assert, expectUnavailable, run } from '../helpers/harness';
import {
  createDoWhile,
  createForIn,
  createForLoop,
  createForOf,
  createIfElse,
  createReturn,
  createSwitch,
  createTernary,
  createThrowError,
  createTryCatch,
  createTryCatchFinally,
  createWhile,
} from '../../src/commands/controlFlow/controlFlowCommands';

describe('control flow commands', () => {
  it('wraps selected statements in an if block preserving indentation', async () => {
    const { text } = await run(createIfElse, `function f() {\n[[  a();\n  b();\n]]}`);
    assert.strictEqual(text, `function f() {\n  if (condition) {\n    a();\n    b();\n  }\n}`);
  });

  it('inserts an if/else skeleton on a blank line', async () => {
    const { text } = await run(createIfElse, `function f() {\n  <|>\n}`);
    assert.strictEqual(text, `function f() {\n  if (condition) {\n    \n  } else {\n    \n  }\n}`);
  });

  it('uses a selected expression statement as condition', async () => {
    const { text } = await run(createIfElse, `function f(ok) {\n  [[ok]];\n}`);
    assert.strictEqual(text, `function f(ok) {\n  if (ok) {\n    \n  }\n}`);
  });

  it('generates switch cases from an enum-typed parameter', async () => {
    const { text, result } = await run(
      createSwitch,
      `enum Status { Active = 'a', Done = 'd' }\nfunction f(status: Status) {\n  [[status]];\n}`,
    );
    assert.ok(
      text.includes(
        `  switch (status) {\n    case Status.Active:\n      \n      break;\n    case Status.Done:\n      \n      break;\n    default:\n      \n      break;\n  }`,
      ),
      text,
    );
    assert.ok(/2 cases/.test(result.message ?? '') || result.message === undefined);
  });

  it('generates switch cases from a literal union parameter', async () => {
    const { text } = await run(
      createSwitch,
      `type Kind = 'a' | 'b';\nfunction f(kind: Kind) {\n  [[kind]];\n}`,
    );
    assert.ok(text.includes(`case 'a':`) && text.includes(`case 'b':`), text);
  });

  it('inserts a for loop over the nearest array variable', async () => {
    const { text } = await run(
      createForLoop,
      `function f() {\n  const users = getUsers();\n  const names: string[] = [];\n  <|>\n}`,
    );
    assert.ok(text.includes('  for (let i = 0; i < names.length; i++) {'), text);
  });

  it('inserts a for...of loop with a singularised item name', async () => {
    const { text } = await run(createForOf, `function f(categories: string[]) {\n  [[categories]];\n}`);
    assert.strictEqual(
      text,
      `function f(categories: string[]) {\n  for (const category of categories) {\n    \n  }\n}`,
    );
  });

  it('inserts a for...in loop over the nearest object', async () => {
    const { text } = await run(createForIn, `const config = { a: 1 };\n<|>\n`);
    assert.ok(text.includes('for (const key in config) {\n  if (Object.hasOwn(config, key)) {'), text);
  });

  it('wraps statements in while and do...while', async () => {
    const w = await run(createWhile, `[[a();]]`);
    assert.strictEqual(w.text, `while (condition) {\n  a();\n}`);
    const d = await run(createDoWhile, `[[a();]]`);
    assert.strictEqual(d.text, `do {\n  a();\n} while (condition);`);
  });

  it('wraps an awaited statement at the cursor in try/catch', async () => {
    const { text } = await run(
      createTryCatch,
      `async function f() {\n  const data = await load();<|>\n  return data;\n}`,
    );
    assert.strictEqual(
      text,
      `async function f() {\n  try {\n    const data = await load();\n  } catch (error) {\n    console.error(error);\n  }\n  return data;\n}`,
    );
  });

  it('wraps a selection in try/catch/finally with a unique error name', async () => {
    const { text } = await run(createTryCatchFinally, `function f(error) {\n[[  risky();\n]]}`);
    assert.strictEqual(
      text,
      `function f(error) {\n  try {\n    risky();\n  } catch (error2) {\n    console.error(error2);\n  } finally {\n    \n  }\n}`,
    );
  });

  it('offers custom error classes when throwing', async () => {
    const { text } = await run(
      createThrowError,
      `class NotFoundError extends Error {}\nfunction f() {\n  <|>\n}`,
    );
    assert.ok(text.includes(`  throw new NotFoundError('message');`), text);
  });

  it('rethrows inside catch clauses', async () => {
    const { text } = await run(createThrowError, `try { a(); } catch (err) {\n  <|>\n}`);
    assert.strictEqual(text, `try { a(); } catch (err) {\n  throw err;\n}`);
  });

  it('inserts a return matching the function', async () => {
    const plain = await run(createReturn, `function f(): number {\n  <|>\n}`);
    assert.strictEqual(plain.text, `function f(): number {\n  return number;\n}`);
    const jsx = await run(createReturn, `function App() {\n  <|>\n}`, { languageId: 'typescriptreact' });
    assert.ok(jsx.text.includes('  return (\n    <div>\n      \n    </div>\n  );'), jsx.text);
    expectUnavailable(createReturn, `const a = 1;<|>`);
  });

  it('converts if/else into a ternary', async () => {
    const ret = await run(
      createTernary,
      `function f(a) {\n  [[if (a) {\n    return 1;\n  } else {\n    return 2;\n  }]]\n}`,
    );
    assert.strictEqual(ret.text, `function f(a) {\n  return a ? 1 : 2;\n}`);
    const assign = await run(createTernary, `let x;\n[[if (a) { x = 1; } else { x = 2; }]]`);
    assert.strictEqual(assign.text, `let x;\nx = a ? 1 : 2;`);
    expectUnavailable(createTernary, `[[if (a) { b(); c(); } else { d(); }]]`);
  });
});
