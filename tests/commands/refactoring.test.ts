import { assert, expectUnavailable, run } from '../helpers/harness';
import {
  extractConstantCommand,
  extractFunctionCommand,
  extractVariableCommand,
  generateDocumentationCommand,
  generateImportCommand,
  generateInterfaceCommand,
  generateTypeCommand,
  wrapWithIfCommand,
  wrapWithLoopCommand,
  wrapWithTryCatchCommand,
} from '../../src/commands/refactoring/refactoringCommands';

describe('refactoring commands', () => {
  it('extract function requires a selection', () => {
    expectUnavailable(extractFunctionCommand, `function f() {\n  a();<|>\n}`);
    expectUnavailable(extractVariableCommand, `const a = 1;<|>`);
    expectUnavailable(extractConstantCommand, `const a = 1;<|>`);
  });

  it('extracts an expression into a function', async () => {
    const { text } = await run(
      extractFunctionCommand,
      `function f(a: number, b: number) {\n  return [[a * b + 1]];\n}`,
    );
    assert.ok(text.includes('  return getSum(a, b);'), text);
    assert.ok(text.includes('function getSum(a: number, b: number) {\n  return a * b + 1;\n}'), text);
  });

  it('describes the extraction in the applicability detail', async () => {
    const { ctx } = await run(extractVariableCommand, `console.log([[a.b]]);`);
    const detail = extractFunctionCommand.canExecute(ctx).detail;
    assert.ok(/getB\(\)/.test(detail ?? ''), detail);
  });

  it('generates JSDoc with params and returns (typed in JS, untyped in TS)', async () => {
    const tsDoc = await run(
      generateDocumentationCommand,
      `export async function fetchUser(id: string, retries = 3): Promise<User> {\n  if (!id) throw new Error('x');\n  return api(id);<|>\n}`,
    );
    assert.ok(
      tsDoc.text.startsWith(
        `/**\n * Fetches user.\n * @param id - description\n * @param retries - description\n * @returns description\n * @throws {Error} when\n */\nexport async function fetchUser`,
      ),
      tsDoc.text,
    );
    const jsDoc = await run(generateDocumentationCommand, `function add(a, b) {\n  return a + <|>b;\n}`, {
      languageId: 'javascript',
    });
    assert.ok(
      jsDoc.text.startsWith(
        `/**\n * Add.\n * @param {*} a - description\n * @param {*} b - description\n * @returns {*} description\n */\nfunction add`,
      ),
      jsDoc.text,
    );
  });

  it('documents indented class methods and skips documented declarations', async () => {
    const { text } = await run(
      generateDocumentationCommand,
      `class A {\n  greet(name: string): string {\n    return na<|>me;\n  }\n}`,
    );
    assert.ok(
      text.includes(
        'class A {\n  /**\n   * Greet.\n   * @param name - description\n   * @returns description\n   */\n  greet(name: string): string {',
      ),
      text,
    );
    expectUnavailable(generateDocumentationCommand, `/** done */\nfunction f() {<|>}`);
  });

  it('wraps selections with try/catch, if and loops', async () => {
    const t = await run(wrapWithTryCatchCommand, `[[a();\nb();]]`);
    assert.strictEqual(t.text, `try {\n  a();\n  b();\n} catch (error) {\n  console.error(error);\n}`);
    const i = await run(wrapWithIfCommand, `[[a();]]`);
    assert.strictEqual(i.text, `if (condition) {\n  a();\n}`);
    const l = await run(wrapWithLoopCommand, `[[a();]]`, { picks: ['for...of'] });
    assert.strictEqual(l.text, `for (const item of items) {\n  a();\n}`);
    expectUnavailable(wrapWithIfCommand, `const a = [[1 + 2]];`);
  });

  it('generate import/type/interface delegate with stricter gates', async () => {
    expectUnavailable(generateImportCommand, `const x = 1;<|>`);
    const imp = await run(generateImportCommand, `const x = [[useState]](1);`, {
      project: { hasReact: true },
    });
    assert.ok(imp.text.startsWith(`import { useState } from 'react';`), imp.text);
    expectUnavailable(generateTypeCommand, `<|>`);
    const type = await run(generateTypeCommand, `const p = [[{ x: 1 }]];`);
    assert.ok(type.text.startsWith('type P = {\n  x: number;\n};'), type.text);
    expectUnavailable(generateInterfaceCommand, `<|>`);
  });
});
