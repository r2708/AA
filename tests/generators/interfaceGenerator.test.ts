import * as ts from 'typescript';
import { assert } from '../helpers/harness';
import {
  emitShape,
  mergeShapes,
  shapeFromObjectLiteral,
  type Shape,
} from '../../src/generators/interfaceGenerator';
import { generateClassCode } from '../../src/generators/classGenerator';
import { analyze } from '../helpers/harness';

function objectLiteral(code: string): { obj: ts.ObjectLiteralExpression; sf: ts.SourceFile } {
  const sf = ts.createSourceFile('x.ts', `const v = ${code};`, ts.ScriptTarget.Latest, true);
  const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
  return { obj: decl.initializer as ts.ObjectLiteralExpression, sf };
}

describe('interface generator', () => {
  it('infers primitives, nested objects, arrays, unions and optionals', () => {
    const { obj, sf } = objectLiteral(
      `{ id: 1, name: 'x', ok: true, none: null, nested: { a: 1 }, list: [1, 'a'], maybe: undefined, fn: (x: number) => x }`,
    );
    const shape = shapeFromObjectLiteral(obj, { sf });
    const emitted = emitShape(shape, 'Thing', {
      kind: 'interface',
      exported: true,
      semi: ';',
      existingNames: new Set(),
    });
    assert.strictEqual(
      emitted.code,
      [
        'export interface ThingNested {',
        '\ta: number;',
        '}',
        '',
        'export interface Thing {',
        '\tid: number;',
        '\tname: string;',
        '\tok: boolean;',
        '\tnone: null;',
        '\tnested: ThingNested;',
        '\tlist: (number | string)[];',
        '\tmaybe?: unknown;',
        '\tfn: (x: number) => unknown;',
        '}',
      ].join('\n'),
    );
    assert.deepStrictEqual(emitted.names, ['ThingNested', 'Thing']);
  });

  it('merges shapes marking missing properties optional', () => {
    const a: Shape = { props: [{ name: 'id', type: { kind: 'text', text: 'number' }, optional: false }] };
    const b: Shape = {
      props: [
        { name: 'id', type: { kind: 'text', text: 'string' }, optional: false },
        { name: 'label', type: { kind: 'text', text: 'string' }, optional: false },
      ],
    };
    const merged = mergeShapes([a, b]);
    assert.deepStrictEqual(
      merged.props.map((p) => `${p.name}${p.optional ? '?' : ''}`),
      ['id', 'label?'],
    );
    assert.strictEqual(merged.props[0].type.kind, 'union');
  });

  it('quotes non-identifier keys and emits type aliases and typedefs', () => {
    const { obj, sf } = objectLiteral(`{ 'content-type': 'json', count: 2 }`);
    const shape = shapeFromObjectLiteral(obj, { sf });
    const alias = emitShape(shape, 'Headers', {
      kind: 'type',
      exported: false,
      semi: '',
      existingNames: new Set(),
    });
    assert.strictEqual(alias.code, "type Headers = {\n\t'content-type': string\n\tcount: number\n}");
    const jsdoc = emitShape(shape, 'Headers', {
      kind: 'jsdoc',
      exported: false,
      semi: ';',
      existingNames: new Set(),
    });
    assert.ok(
      jsdoc.code.startsWith("/**\n * @typedef {Object} Headers\n * @property {string} 'content-type'"),
      jsdoc.code,
    );
  });

  it('avoids nested name collisions', () => {
    const { obj, sf } = objectLiteral(`{ address: { city: 'x' } }`);
    const shape = shapeFromObjectLiteral(obj, { sf });
    const emitted = emitShape(shape, 'User', {
      kind: 'interface',
      exported: false,
      semi: ';',
      existingNames: new Set(['UserAddress']),
    });
    assert.ok(emitted.code.includes('interface UserAddress2 {'), emitted.code);
    assert.ok(emitted.code.includes('address: UserAddress2;'), emitted.code);
  });
});

describe('class generator', () => {
  it('emits TypeScript and JavaScript variants', () => {
    const tsCtx = analyze('<|>');
    const tsCode = generateClassCode(tsCtx, {
      name: 'User',
      members: [
        { name: 'id', typeText: 'string', optional: false },
        { name: 'nick', typeText: 'string', optional: true },
      ],
      exported: true,
      implementsName: 'IUser',
    });
    assert.strictEqual(
      tsCode,
      'export class User implements IUser {\n\tid: string;\n\tnick?: string;\n\n\tconstructor(id: string, nick?: string) {\n\t\tthis.id = id;\n\t\tthis.nick = nick;\n\t}\n}',
    );
    const jsCtx = analyze('<|>', { languageId: 'javascript' });
    const jsCode = generateClassCode(jsCtx, {
      name: 'User',
      members: [{ name: 'id', optional: false }],
      exported: false,
      extendsName: 'Base',
    });
    assert.strictEqual(
      jsCode,
      'class User extends Base {\n\tconstructor(id) {\n\t\tsuper();\n\t\tthis.id = id;\n\t}\n}',
    );
  });
});
