import * as ts from 'typescript';
import { assert } from '../helpers/harness';
import {
  deriveNameFromExpression,
  deriveConstantName,
  singularize,
  pluralize,
  toPascalCase,
  toCamelCase,
  toUpperSnakeCase,
  uniqueName,
  nameFromFileName,
} from '../../src/analyzer/naming';

function expr(code: string): { node: ts.Expression; sf: ts.SourceFile } {
  const sf = ts.createSourceFile('x.ts', `const __v = ${code};`, ts.ScriptTarget.Latest, true);
  const stmt = sf.statements[0] as ts.VariableStatement;
  return { node: stmt.declarationList.declarations[0].initializer as ts.Expression, sf };
}

describe('naming', () => {
  it('derives variable names from expressions', () => {
    const cases: [string, string][] = [
      ['user.profile.name', 'profileName'],
      ['user.profile', 'profile'],
      ['await getUser(id)', 'user'],
      ['fetch(url)', 'response'],
      ['response.json()', 'data'],
      ['new UserService()', 'userService'],
      ['items.filter(Boolean)', 'filtered'],
      ['price * quantity', 'product'],
      ['a === b', 'condition'],
      ['"hello"', 'text'],
      ['[1, 2]', 'items'],
      ['users[0]', 'user'],
      ['useAuth()', 'auth'],
    ];
    for (const [code, expected] of cases) {
      const { node, sf } = expr(code);
      assert.strictEqual(deriveNameFromExpression(node, sf), expected, code);
    }
  });
  it('derives constant names', () => {
    assert.strictEqual(
      deriveConstantName(expr("'https://api.example.com'").node, expr("'x'").sf),
      'HTTPS_API_EXAMPLE_COM',
    );
    assert.strictEqual(deriveConstantName(expr('42').node, expr('1').sf), 'VALUE');
  });
  it('converts cases', () => {
    assert.strictEqual(toPascalCase('user-service'), 'UserService');
    assert.strictEqual(toPascalCase('userService'), 'UserService');
    assert.strictEqual(toCamelCase('User Profile Name'), 'userProfileName');
    assert.strictEqual(toUpperSnakeCase('apiBaseUrl'), 'API_BASE_URL');
  });
  it('singularises and pluralises', () => {
    assert.strictEqual(singularize('users'), 'user');
    assert.strictEqual(singularize('categories'), 'category');
    assert.strictEqual(singularize('children'), 'child');
    assert.strictEqual(singularize('status'), 'status');
    assert.strictEqual(pluralize('category'), 'categories');
    assert.strictEqual(pluralize('user'), 'users');
  });
  it('avoids collisions and reserved words', () => {
    assert.strictEqual(uniqueName('user', new Set(['user'])), 'user2');
    assert.strictEqual(uniqueName('user', new Set(['user', 'user2'])), 'user3');
    assert.strictEqual(uniqueName('class', new Set()), 'classValue');
  });
  it('derives names from file names', () => {
    assert.strictEqual(nameFromFileName('/a/b/user-profile.tsx'), 'UserProfile');
    assert.strictEqual(nameFromFileName('/a/b/user.service.ts'), 'UserService');
    assert.strictEqual(nameFromFileName('/a/components/index.tsx'), 'Components');
  });
});
