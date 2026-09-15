/**
 * Identifier naming helpers: case conversion, pluralisation, name derivation
 * from expressions and collision avoidance.
 */
import * as ts from 'typescript';

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'async',
  'of',
  'type',
  'undefined',
  'NaN',
  'Infinity',
  'arguments',
  'eval',
]);

export function isReservedWord(name: string): boolean {
  return RESERVED.has(name);
}

export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !isReservedWord(name);
}

export function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
}

export function toCamelCase(input: string): string {
  const words = splitWords(input);
  if (words.length === 0) {
    return '';
  }
  return words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join('')
    .replace(/^[0-9]/, (d) => `_${d}`);
}

export function toPascalCase(input: string): string {
  const words = splitWords(input);
  if (words.length === 0) {
    return '';
  }
  return words
    .map(
      (w) =>
        w.charAt(0).toUpperCase() +
        (w.length > 1 && w === w.toUpperCase() ? w.slice(1).toLowerCase() : w.slice(1)),
    )
    .join('')
    .replace(/^[0-9]/, (d) => `_${d}`);
}

export function toUpperSnakeCase(input: string): string {
  const words = splitWords(input);
  if (words.length === 0) {
    return '';
  }
  return words
    .map((w) => w.toUpperCase())
    .join('_')
    .replace(/^[0-9]/, (d) => `_${d}`);
}

export function capitalize(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

export function uncapitalize(input: string): string {
  return input.charAt(0).toLowerCase() + input.slice(1);
}

const IRREGULAR_SINGULAR: Record<string, string> = {
  children: 'child',
  people: 'person',
  men: 'man',
  women: 'woman',
  data: 'item',
  items: 'item',
  entries: 'entry',
  indices: 'index',
  statuses: 'status',
  mice: 'mouse',
  feet: 'foot',
  teeth: 'tooth',
  series: 'series',
};

export function singularize(name: string): string {
  const lower = name.toLowerCase();
  const irregular = IRREGULAR_SINGULAR[lower];
  if (irregular) {
    return matchCase(name, irregular);
  }
  if (/[^aeiou]ies$/.test(name)) {
    return name.slice(0, -3) + 'y';
  }
  if (/(ss|us|is)$/.test(name)) {
    return name;
  }
  if (/(sh|ch|x|z|s)es$/.test(name)) {
    return name.slice(0, -2);
  }
  if (/[^s]s$/.test(name)) {
    return name.slice(0, -1);
  }
  return name;
}

export function pluralize(name: string): string {
  if (/[^aeiou]y$/.test(name)) {
    return name.slice(0, -1) + 'ies';
  }
  if (/(sh|ch|x|z|s)$/.test(name)) {
    return name + 'es';
  }
  if (/s$/.test(name)) {
    return name;
  }
  return name + 's';
}

function matchCase(source: string, target: string): string {
  if (
    source.charAt(0) === source.charAt(0).toUpperCase() &&
    source.charAt(0) !== source.charAt(0).toLowerCase()
  ) {
    return capitalize(target);
  }
  return target;
}

/** Returns `base`, or `base2`, `base3`... until the name is not taken. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  let candidate = base;
  if (isReservedWord(candidate)) {
    candidate = `${candidate}Value`;
  }
  let i = 2;
  while (set.has(candidate)) {
    candidate = `${base}${i}`;
    i += 1;
  }
  return candidate;
}

/** Derives a PascalCase symbol name from a file name (`user-service.ts` → `UserService`). */
export function nameFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const withoutExt = base.replace(/\.(test|spec|stories)\.[a-z]+$/i, '').replace(/\.[a-z0-9]+$/i, '');
  if (!withoutExt || withoutExt === 'index') {
    const dir = fileName.split(/[\\/]/).slice(-2, -1)[0];
    return dir ? toPascalCase(dir) : 'Component';
  }
  return toPascalCase(withoutExt);
}

/** File base name without extension. */
export function baseNameOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

const GENERIC_PROPERTY_NAMES = new Set([
  'name',
  'id',
  'value',
  'data',
  'type',
  'key',
  'count',
  'length',
  'result',
  'item',
  'items',
  'list',
  'text',
  'title',
  'label',
  'status',
  'code',
  'message',
  'url',
  'path',
  'index',
  'first',
  'last',
  'current',
]);

const ACCESSOR_PREFIXES =
  /^(get|fetch|load|find|read|retrieve|compute|calculate|build|create|make|resolve|select|query|parse|generate)([A-Z].*)$/;

const CALL_NAME_HINTS: Record<string, string> = {
  fetch: 'response',
  json: 'data',
  text: 'text',
  parse: 'parsed',
  stringify: 'json',
  map: 'mapped',
  filter: 'filtered',
  reduce: 'total',
  find: 'found',
  sort: 'sorted',
  join: 'joined',
  split: 'parts',
  keys: 'keys',
  values: 'values',
  entries: 'entries',
  now: 'now',
  trim: 'trimmed',
  toLowerCase: 'lower',
  toUpperCase: 'upper',
  slice: 'slice',
  includes: 'has',
  some: 'has',
  every: 'all',
  length: 'length',
  querySelector: 'element',
  getElementById: 'element',
  readFile: 'content',
  readFileSync: 'content',
};

function nameFromCallee(callee: ts.Expression): string | undefined {
  let name: string | undefined;
  if (ts.isIdentifier(callee)) {
    name = callee.text;
  } else if (ts.isPropertyAccessExpression(callee)) {
    name = callee.name.text;
  }
  if (!name) {
    return undefined;
  }
  const hint = CALL_NAME_HINTS[name];
  if (hint) {
    return hint;
  }
  const accessor = ACCESSOR_PREFIXES.exec(name);
  if (accessor) {
    return uncapitalize(accessor[2]);
  }
  if (
    name.startsWith('is') ||
    name.startsWith('has') ||
    name.startsWith('can') ||
    name.startsWith('should')
  ) {
    return name;
  }
  if (/^(use)[A-Z]/.test(name)) {
    return uncapitalize(name.slice(3));
  }
  return `${name}Result`;
}

/**
 * Suggests a camelCase variable name for an expression.
 *   user.profile.name   → profileName
 *   await getUser(id)   → user
 *   new UserService()   → userService
 *   items.filter(...)   → filtered
 */
export function deriveNameFromExpression(expr: ts.Expression, sf: ts.SourceFile): string {
  let node: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  if (ts.isIdentifier(node)) {
    return `${node.text}Copy`;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const last = node.name.text;
    if (GENERIC_PROPERTY_NAMES.has(last)) {
      const parent = node.expression;
      const parentName = ts.isIdentifier(parent)
        ? parent.text
        : ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : parent.kind === ts.SyntaxKind.ThisKeyword
            ? ''
            : ts.isCallExpression(parent)
              ? (nameFromCallee(parent.expression) ?? '')
              : '';
      if (parentName && parentName !== 'this') {
        return toCamelCase(`${parentName} ${last}`);
      }
    }
    return toCamelCase(last);
  }
  if (ts.isElementAccessExpression(node)) {
    const target = node.expression;
    if (ts.isIdentifier(target)) {
      return singularize(target.text);
    }
    if (ts.isPropertyAccessExpression(target)) {
      return singularize(target.name.text);
    }
    return 'element';
  }
  if (ts.isCallExpression(node)) {
    return nameFromCallee(node.expression) ?? 'result';
  }
  if (ts.isNewExpression(node)) {
    const name = node.expression.getText(sf).split('.').pop() ?? 'instance';
    return uncapitalize(name);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    return 'text';
  }
  if (ts.isNumericLiteral(node)) {
    return 'value';
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return 'flag';
  }
  if (ts.isArrayLiteralExpression(node)) {
    return 'items';
  }
  if (ts.isObjectLiteralExpression(node)) {
    return 'options';
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return 'callback';
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    ) {
      return 'condition';
    }
    if (op === ts.SyntaxKind.AsteriskToken) {
      return 'product';
    }
    if (op === ts.SyntaxKind.PlusToken) {
      return 'sum';
    }
    if (op === ts.SyntaxKind.MinusToken) {
      return 'difference';
    }
    if (op === ts.SyntaxKind.SlashToken) {
      return 'quotient';
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      return deriveNameFromExpression(node.left, sf);
    }
    return 'result';
  }
  if (ts.isConditionalExpression(node)) {
    return 'result';
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return 'isNot' + capitalize(deriveNameFromExpression(node.operand, sf));
  }
  if (ts.isTypeOfExpression(node)) {
    return 'type';
  }
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return 'element';
  }
  return 'value';
}

/** Constant name for a literal (`'https://api'` → `API`, `3.14` → `PI`-like fallback `VALUE`). */
export function deriveConstantName(expr: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    const words = splitWords(expr.text).slice(0, 4);
    if (words.length > 0) {
      return toUpperSnakeCase(words.join(' '));
    }
    return 'TEXT';
  }
  if (ts.isNumericLiteral(expr)) {
    return 'VALUE';
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return 'ITEMS';
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return 'OPTIONS';
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return 'VALUE';
  }
  return toUpperSnakeCase(deriveNameFromExpression(expr, sf)) || 'VALUE';
}

/** Suggests a function name from the statements it will contain. */
export function deriveFunctionName(statements: readonly ts.Statement[], sf: ts.SourceFile): string {
  const first = statements[0];
  const last = statements[statements.length - 1];
  if (!first) {
    return 'extracted';
  }
  if (ts.isReturnStatement(last) && last.expression) {
    return 'compute' + capitalize(deriveNameFromExpression(last.expression, sf));
  }
  if (ts.isVariableStatement(first)) {
    const decl = first.declarationList.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) {
      const init = decl.initializer;
      if (init && ts.isAwaitExpression(init)) {
        return 'fetch' + capitalize(decl.name.text);
      }
      if (init && ts.isBinaryExpression(init)) {
        return 'calculate' + capitalize(decl.name.text);
      }
      return 'get' + capitalize(decl.name.text);
    }
  }
  if (ts.isExpressionStatement(first) && ts.isCallExpression(first.expression)) {
    const callee = first.expression.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.expression.getText(sf) === 'console') {
      return 'log' + (statements.length > 1 ? 'Results' : 'Value');
    }
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    if (name) {
      return 'handle' + capitalize(name);
    }
  }
  if (ts.isIfStatement(first)) {
    return (
      'check' + capitalize(deriveNameFromExpression(first.expression, sf).replace(/^condition$/, 'Condition'))
    );
  }
  if (
    ts.isForStatement(first) ||
    ts.isForOfStatement(first) ||
    ts.isForInStatement(first) ||
    ts.isWhileStatement(first)
  ) {
    return (
      'process' +
      (ts.isForOfStatement(first)
        ? capitalize(pluralize(deriveNameFromExpression(first.expression, sf)))
        : 'Items')
    );
  }
  return 'extracted';
}
