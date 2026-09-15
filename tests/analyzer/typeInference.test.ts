import * as ts from 'typescript';
import { assert } from '../helpers/harness';
import {
  inferTypeFromUsage,
  literalTypeText,
  checkerTypeText,
  createSingleFileChecker,
  sampleValueForType,
} from '../../src/analyzer/typeInference';

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
}

describe('type inference', () => {
  it('infers from usage', () => {
    const sf = parse(
      `function f(price, quantity, name, items, cb) { const t = price * quantity; name.toUpperCase(); items.map(x => x); cb(); }`,
    );
    assert.strictEqual(inferTypeFromUsage('price', sf), 'number');
    assert.strictEqual(inferTypeFromUsage('quantity', sf), 'number');
    assert.strictEqual(inferTypeFromUsage('name', sf), 'string');
    assert.strictEqual(inferTypeFromUsage('items', sf), 'unknown[]');
    assert.strictEqual(inferTypeFromUsage('cb', sf), '(...args: unknown[]) => unknown');
    assert.strictEqual(inferTypeFromUsage('missing', sf), undefined);
  });
  it('infers literal types', () => {
    const sf = parse(`const a = 'x', b = 1, c = true, d = null, e = -1, f = a === b, g = () => 1;`);
    const decls = (sf.statements[0] as ts.VariableStatement).declarationList.declarations;
    const types = decls.map((d) => literalTypeText(d.initializer as ts.Expression));
    assert.deepStrictEqual(types, [
      'string',
      'number',
      'boolean',
      'null',
      'number',
      'boolean',
      '() => unknown',
    ]);
  });
  it('uses the single-file checker for declared types', () => {
    const sf = parse(
      `const price = 5; const name: string = 'a'; function f(x: number[]) { return x; } const y = f([1]);`,
    );
    const checker = createSingleFileChecker(sf);
    const stmts = sf.statements;
    const priceDecl = (stmts[0] as ts.VariableStatement).declarationList.declarations[0];
    assert.strictEqual(checkerTypeText(checker, priceDecl.name), 'number');
    const yDecl = (stmts[3] as ts.VariableStatement).declarationList.declarations[0];
    assert.strictEqual(checkerTypeText(checker, yDecl.name), 'number[]');
  });
  it('generates sample values', () => {
    assert.strictEqual(sampleValueForType('string', 'email', "'"), "'user@example.com'");
    assert.strictEqual(sampleValueForType('number', 'id', "'"), '1');
    assert.strictEqual(sampleValueForType('boolean', 'active', "'"), 'true');
    assert.strictEqual(sampleValueForType('string[]', 'tags', "'"), '[]');
    assert.strictEqual(sampleValueForType("'a' | 'b'", 'kind', "'"), "'a'");
    assert.strictEqual(sampleValueForType('Date', 'createdAt', "'"), 'new Date()');
  });
});
