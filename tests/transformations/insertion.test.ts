import { assert, analyze } from '../helpers/harness';
import {
  planStatementInsertion,
  planTopLevelInsertion,
  planImportInsertion,
} from '../../src/transformations/insertion';
import { ensureImports } from '../../src/transformations/importManager';
import { applyTextEdits, renderCode, adjustOffset } from '../../src/generators/codeWriter';

describe('insertion planning', () => {
  it('reuses a blank cursor line with the scope indentation', () => {
    const ctx = analyze(`function f() {\n  if (x) {\n\n  }\n}`.replace('\n\n', '\n<|>\n'));
    const plan = planStatementInsertion(ctx);
    assert.strictEqual(plan.indent, '    ');
    assert.strictEqual(plan.prefix, '');
  });

  it('inserts after the statement containing the cursor', () => {
    const ctx = analyze(`function f() {\n  const a = compute(1,<|> 2);\n  return a;\n}`);
    const plan = planStatementInsertion(ctx);
    const text = applyTextEdits(ctx.text, [
      { range: plan.range, text: plan.prefix + renderCode('log(a);', ctx, plan.indent) + plan.suffix },
    ]);
    assert.strictEqual(text, `function f() {\n  const a = compute(1, 2);\n  log(a);\n  return a;\n}`);
  });

  it('inserts before a statement when the cursor is at its start', () => {
    const ctx = analyze(`function f() {\n  <|>return 1;\n}`);
    const plan = planStatementInsertion(ctx);
    const text = applyTextEdits(ctx.text, [
      { range: plan.range, text: plan.prefix + renderCode('log();', ctx, plan.indent) + plan.suffix },
    ]);
    assert.strictEqual(text, `function f() {\n  log();\n  return 1;\n}`);
  });

  it('handles cursors right after an opening brace on one-line bodies', () => {
    const ctx = analyze(`function f() {<|>}`);
    const plan = planStatementInsertion(ctx);
    const text = applyTextEdits(ctx.text, [
      { range: plan.range, text: plan.prefix + renderCode('log();', ctx, plan.indent) + plan.suffix },
    ]);
    assert.strictEqual(text, `function f() {\n  log();\n}`);
  });

  it('places top-level declarations before/after the enclosing statement with blank lines', () => {
    const ctx = analyze(`import a from 'a';\n\n/** doc */\nfunction f() {\n  x(<|>);\n}\nconst z = 1;\n`);
    const before = planTopLevelInsertion(ctx, { position: 'before' });
    const textBefore = applyTextEdits(ctx.text, [
      { range: before.range, text: before.prefix + renderCode('interface A {}', ctx) + before.suffix },
    ]);
    assert.strictEqual(
      textBefore,
      `import a from 'a';\n\ninterface A {}\n\n/** doc */\nfunction f() {\n  x();\n}\nconst z = 1;\n`,
    );
    const after = planTopLevelInsertion(ctx, { position: 'after' });
    const textAfter = applyTextEdits(ctx.text, [
      { range: after.range, text: after.prefix + renderCode('function g() {}', ctx) + after.suffix },
    ]);
    assert.strictEqual(
      textAfter,
      `import a from 'a';\n\n/** doc */\nfunction f() {\n  x();\n}\n\nfunction g() {}\n\nconst z = 1;\n`,
    );
  });

  it('adds imports at the top of files without imports and after a license header', () => {
    const ctx = analyze(`const a = 1;<|>`);
    const plan = planImportInsertion(ctx);
    assert.deepStrictEqual(plan.range, { start: 0, end: 0 });
    assert.strictEqual(plan.suffix, '\n\n');
  });

  it('renders CRLF and tabs', () => {
    const ctx = analyze(`function f() {\r\n\t<|>\r\n}`, { useTabs: true, eol: '\r\n' });
    assert.strictEqual(renderCode('if (a) {\n\tb();\n}', ctx, '\t'), 'if (a) {\r\n\t\tb();\r\n\t}');
  });

  it('adjusts offsets across edits', () => {
    const edits = [
      { range: { start: 0, end: 0 }, text: 'abc' },
      { range: { start: 10, end: 12 }, text: '' },
    ];
    assert.strictEqual(adjustOffset(5, edits), 8);
    assert.strictEqual(adjustOffset(15, edits), 16);
  });
});

describe('import manager', () => {
  it('merges named imports, converts default-only imports and handles namespaces', () => {
    const merge = analyze(`import { a } from 'm';\n<|>`);
    let res = ensureImports(merge, [{ module: 'm', named: ['b', 'a'] }]);
    assert.strictEqual(applyTextEdits(merge.text, res.edits), `import { a, b } from 'm';\n`);
    assert.deepStrictEqual(res.reused, ['a']);
    const def = analyze(`import React from 'react';\n<|>`);
    res = ensureImports(def, [{ module: 'react', named: ['useState'] }]);
    assert.strictEqual(applyTextEdits(def.text, res.edits), `import React, { useState } from 'react';\n`);
    const ns = analyze(`import * as R from 'react';\n<|>`);
    res = ensureImports(ns, [{ module: 'react', named: ['useState'] }]);
    assert.strictEqual(res.edits.length, 0);
    assert.strictEqual(res.localNames.get('useState'), 'R.useState');
  });

  it('respects aliases, multi-line imports and type-only requests', () => {
    const alias = analyze(`import { useState as useS } from 'react';\n<|>`);
    let res = ensureImports(alias, [{ module: 'react', named: ['useState'] }]);
    assert.strictEqual(res.edits.length, 0);
    assert.strictEqual(res.localNames.get('useState'), 'useS');
    const multi = analyze(`import {\n  a,\n  b,\n} from 'm';\n<|>`);
    res = ensureImports(multi, [{ module: 'm', named: ['c'] }]);
    assert.strictEqual(applyTextEdits(multi.text, res.edits), `import {\n  a,\n  b,\n  c,\n} from 'm';\n`);
    const typeOnly = analyze(`import { a } from 'm';\n<|>`);
    res = ensureImports(typeOnly, [{ module: 'm', named: ['T'], typeOnly: true }]);
    assert.strictEqual(
      applyTextEdits(typeOnly.text, res.edits),
      `import { a } from 'm';\nimport type { T } from 'm';\n`,
    );
  });
});
