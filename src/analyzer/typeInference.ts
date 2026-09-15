/**
 * Best-effort type inference. Combines literal analysis, a single-file type
 * checker (no lib, no module resolution → fast) and usage-based heuristics.
 */
import * as ts from 'typescript';

/**
 * Minimal standard library so the checker can resolve arrays, strings, promises and
 * common methods without loading (and parsing) the real lib.d.ts files on every command.
 */
const MINIMAL_LIB = `
interface Object {}
interface Function { call(thisArg: unknown, ...args: unknown[]): unknown; apply(thisArg: unknown, args?: unknown[]): unknown; bind(thisArg: unknown, ...args: unknown[]): unknown; }
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface IArguments { [index: number]: unknown; length: number; }
interface Symbol {}
interface Boolean {}
interface Number { toFixed(digits?: number): string; toString(radix?: number): string; }
interface BigInt {}
interface RegExp { test(value: string): boolean; exec(value: string): RegExpExecArray | null; }
interface RegExpExecArray extends Array<string> { index: number; input: string; }
interface Error { name: string; message: string; stack?: string; cause?: unknown; }
interface ErrorConstructor { new (message?: string, options?: { cause?: unknown }): Error; (message?: string): Error; }
declare var Error: ErrorConstructor;
interface String {
  length: number;
  charAt(index: number): string;
  includes(search: string): boolean;
  indexOf(search: string): number;
  startsWith(search: string): boolean;
  endsWith(search: string): boolean;
  slice(start?: number, end?: number): string;
  split(separator: string | RegExp, limit?: number): string[];
  toUpperCase(): string;
  toLowerCase(): string;
  trim(): string;
  replace(search: string | RegExp, replacement: string): string;
  padStart(length: number, fill?: string): string;
  [index: number]: string;
}
interface Array<T> {
  length: number;
  [n: number]: T;
  push(...items: T[]): number;
  pop(): T | undefined;
  concat(...items: (T | T[])[]): T[];
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
  indexOf(item: T): number;
  includes(item: T): boolean;
  forEach(callback: (value: T, index: number, array: T[]) => void): void;
  map<U>(callback: (value: T, index: number, array: T[]) => U): U[];
  filter(callback: (value: T, index: number, array: T[]) => unknown): T[];
  find(callback: (value: T, index: number, array: T[]) => unknown): T | undefined;
  findIndex(callback: (value: T, index: number, array: T[]) => unknown): number;
  some(callback: (value: T, index: number, array: T[]) => unknown): boolean;
  every(callback: (value: T, index: number, array: T[]) => unknown): boolean;
  reduce<U>(callback: (acc: U, value: T, index: number, array: T[]) => U, initial: U): U;
  reduce(callback: (acc: T, value: T, index: number, array: T[]) => T): T;
  sort(compare?: (a: T, b: T) => number): this;
  flatMap<U>(callback: (value: T, index: number, array: T[]) => U | U[]): U[];
}
interface ReadonlyArray<T> { readonly length: number; readonly [n: number]: T; map<U>(callback: (value: T, index: number) => U): U[]; filter(callback: (value: T, index: number) => unknown): T[]; }
interface ConcatArray<T> { readonly length: number; readonly [n: number]: T; }
interface ArrayLike<T> { readonly length: number; readonly [n: number]: T; }
interface PromiseLike<T> { then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2>; }
interface Promise<T> {
  then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2>;
  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R>;
  finally(onfinally?: (() => void) | null): Promise<T>;
}
interface PromiseConstructor { resolve<T>(value: T | PromiseLike<T>): Promise<T>; reject<T = never>(reason?: unknown): Promise<T>; all<T>(values: Iterable<T | PromiseLike<T>>): Promise<T[]>; }
declare var Promise: PromiseConstructor;
interface Iterable<T> {}
interface IterableIterator<T> extends Iterable<T> {}
interface Iterator<T> {}
interface Generator<T = unknown, TReturn = unknown, TNext = unknown> extends Iterator<T> {}
interface AsyncIterable<T> {}
interface AsyncGenerator<T = unknown, TReturn = unknown, TNext = unknown> {}
interface Date { getTime(): number; toISOString(): string; }
interface DateConstructor { new (value?: number | string | Date): Date; now(): number; }
declare var Date: DateConstructor;
interface Map<K, V> { get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; delete(key: K): boolean; size: number; }
interface MapConstructor { new <K, V>(entries?: Iterable<[K, V]>): Map<K, V>; }
declare var Map: MapConstructor;
interface Set<T> { add(value: T): this; has(value: T): boolean; delete(value: T): boolean; size: number; }
interface SetConstructor { new <T>(values?: Iterable<T>): Set<T>; }
declare var Set: SetConstructor;
interface JSON { parse(text: string): unknown; stringify(value: unknown, replacer?: unknown, space?: string | number): string; }
declare var JSON: JSON;
interface Math { floor(x: number): number; round(x: number): number; max(...values: number[]): number; min(...values: number[]): number; random(): number; }
declare var Math: Math;
interface Console { log(...data: unknown[]): void; error(...data: unknown[]): void; warn(...data: unknown[]): void; info(...data: unknown[]): void; }
declare var console: Console;
type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Record<K extends keyof any, T> = { [P in K]: T };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type NonNullable<T> = T & {};
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
type Awaited<T> = T extends null | undefined ? T : T extends object & { then(onfulfilled: infer F, ...args: infer _): any } ? F extends (value: infer V, ...args: infer _) => any ? Awaited<V> : never : T;
`;

let minimalLibFile: ts.SourceFile | undefined;
function getMinimalLib(): ts.SourceFile {
  if (!minimalLibFile) {
    minimalLibFile = ts.createSourceFile(
      'lib.d.ts',
      MINIMAL_LIB,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
  }
  return minimalLibFile;
}

export function createSingleFileChecker(sf: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    noLib: false,
    noResolve: true,
    allowJs: true,
    checkJs: false,
    strict: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    types: [],
    noEmit: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sf.fileName ? sf : name === 'lib.d.ts' ? getMinimalLib() : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === sf.fileName || name === 'lib.d.ts',
    readFile: () => undefined,
    directoryExists: () => true,
    getDirectories: () => [],
  };
  const program = ts.createProgram([sf.fileName], options, host);
  return program.getTypeChecker();
}

const UNHELPFUL_TYPES = new Set(['any', 'error', 'unknown', 'never', '{}', 'undefined', 'null']);

/** Type of an expression as a string, or undefined when the checker cannot tell. */
export function checkerTypeText(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  try {
    let type = checker.getTypeAtLocation(node);
    type = checker.getBaseTypeOfLiteralType(type);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) {
      return undefined;
    }
    const text = checker.typeToString(
      type,
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
    );
    if (UNHELPFUL_TYPES.has(text) || text.includes('any') || text.includes('error')) {
      return undefined;
    }
    if (/^typeof /.test(text) || (text.includes('=>') && text.length > 80)) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

export function literalTypeText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    return 'string';
  }
  if (ts.isNumericLiteral(node)) {
    return 'number';
  }
  if (ts.isBigIntLiteral(node)) {
    return 'bigint';
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return 'null';
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return 'RegExp';
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      return 'boolean';
    }
    if (ts.isNumericLiteral(node.operand)) {
      return 'number';
    }
  }
  if (ts.isNewExpression(node)) {
    const text = node.expression.getText();
    if (/^[A-Z][A-Za-z0-9.]*$/.test(text)) {
      return text;
    }
  }
  if (ts.isTypeOfExpression(node)) {
    return 'string';
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
      op === ts.SyntaxKind.InstanceOfKeyword ||
      op === ts.SyntaxKind.InKeyword
    ) {
      return 'boolean';
    }
    if (
      op === ts.SyntaxKind.MinusToken ||
      op === ts.SyntaxKind.AsteriskToken ||
      op === ts.SyntaxKind.SlashToken ||
      op === ts.SyntaxKind.PercentToken ||
      op === ts.SyntaxKind.AsteriskAsteriskToken
    ) {
      return 'number';
    }
    if (op === ts.SyntaxKind.PlusToken) {
      const l = literalTypeText(node.left);
      const r = literalTypeText(node.right);
      if (l === 'string' || r === 'string') {
        return 'string';
      }
      if (l === 'number' && r === 'number') {
        return 'number';
      }
    }
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const params = node.parameters
      .map((p) => `${p.name.getText()}: ${p.type ? p.type.getText() : 'unknown'}`)
      .join(', ');
    const ret = node.type
      ? node.type.getText()
      : ts.isBlock(node.body)
        ? containsReturnValue(node.body)
          ? 'unknown'
          : 'void'
        : 'unknown';
    return `(${params}) => ${ret}`;
  }
  return undefined;
}

function containsReturnValue(body: ts.Block): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isReturnStatement(n) && n.expression) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(n)) {
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

const STRING_METHODS = new Set([
  'toUpperCase',
  'toLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'padStart',
  'padEnd',
  'charAt',
  'startsWith',
  'endsWith',
  'replace',
  'replaceAll',
  'substring',
  'split',
  'localeCompare',
  'toFixed',
]);
const ARRAY_METHODS = new Set([
  'map',
  'filter',
  'forEach',
  'reduce',
  'push',
  'pop',
  'shift',
  'unshift',
  'some',
  'every',
  'find',
  'findIndex',
  'flatMap',
  'sort',
  'splice',
  'indexOf',
  'join',
]);

/**
 * Infers the type of an identifier from how it is used within `root`
 * (`price * quantity` → number, `name.toUpperCase()` → string, `items.map(...)` → unknown[]).
 */
export function inferTypeFromUsage(name: string, root: ts.Node): string | undefined {
  let inferred: string | undefined;
  const visit = (node: ts.Node): void => {
    if (inferred) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      if (parent && ts.isBinaryExpression(parent) && (parent.left === node || parent.right === node)) {
        const op = parent.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AsteriskToken ||
          op === ts.SyntaxKind.MinusToken ||
          op === ts.SyntaxKind.SlashToken ||
          op === ts.SyntaxKind.PercentToken ||
          op === ts.SyntaxKind.AsteriskAsteriskToken ||
          op === ts.SyntaxKind.LessThanToken ||
          op === ts.SyntaxKind.GreaterThanToken ||
          op === ts.SyntaxKind.LessThanEqualsToken ||
          op === ts.SyntaxKind.GreaterThanEqualsToken ||
          op === ts.SyntaxKind.AsteriskEqualsToken ||
          op === ts.SyntaxKind.MinusEqualsToken
        ) {
          inferred = 'number';
          return;
        }
        if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) {
          const other = parent.left === node ? parent.right : parent.left;
          const otherType = literalTypeText(other);
          if (otherType === 'number' || otherType === 'string') {
            inferred = otherType;
            return;
          }
        }
        if (
          op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
          const other = parent.left === node ? parent.right : parent.left;
          const otherType = literalTypeText(other);
          if (otherType && otherType !== 'null') {
            inferred = otherType;
            return;
          }
        }
      }
      if (
        parent &&
        ts.isPrefixUnaryExpression(parent) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken ||
          parent.operator === ts.SyntaxKind.MinusToken)
      ) {
        inferred = 'number';
        return;
      }
      if (parent && ts.isPostfixUnaryExpression(parent)) {
        inferred = 'number';
        return;
      }
      if (parent && ts.isTemplateSpan(parent)) {
        // Template interpolation: ambiguous, skip.
      }
      if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const member = parent.name.text;
        if (STRING_METHODS.has(member)) {
          inferred = 'string';
          return;
        }
        if (ARRAY_METHODS.has(member)) {
          inferred = 'unknown[]';
          return;
        }
      }
      if (parent && ts.isCallExpression(parent) && parent.expression === node) {
        inferred = `(...args: unknown[]) => unknown`;
        return;
      }
      if (parent && ts.isForOfStatement(parent) && parent.expression === node) {
        inferred = 'unknown[]';
        return;
      }
      if (parent && ts.isElementAccessExpression(parent) && parent.expression === node) {
        inferred = ts.isNumericLiteral(parent.argumentExpression) ? 'unknown[]' : 'Record<string, unknown>';
        return;
      }
      if (parent && ts.isAwaitExpression(parent)) {
        inferred = 'Promise<unknown>';
        return;
      }
      if (parent && (ts.isIfStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === node) {
        inferred = 'boolean';
        return;
      }
      if (parent && ts.isJsxExpression(parent)) {
        // could be anything renderable
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return inferred;
}

/** Sample value literal for a type text (used by test/mock data generators and object generation). */
export function sampleValueForType(typeText: string | undefined, propName: string, quote: string): string {
  const t = (typeText ?? 'unknown').trim();
  const lowerName = propName.toLowerCase();
  if (t === 'string') {
    if (lowerName.includes('email')) {
      return `${quote}user@example.com${quote}`;
    }
    if (lowerName.includes('url')) {
      return `${quote}https://example.com${quote}`;
    }
    if (lowerName === 'id' || lowerName.endsWith('id')) {
      return `${quote}${propName}-1${quote}`;
    }
    if (lowerName.includes('date') || lowerName.includes('at')) {
      return `${quote}2024-01-01T00:00:00.000Z${quote}`;
    }
    return `${quote}${propName}${quote}`;
  }
  if (t === 'number') {
    if (lowerName === 'id' || lowerName.endsWith('id')) {
      return '1';
    }
    if (lowerName.includes('price') || lowerName.includes('amount') || lowerName.includes('total')) {
      return '9.99';
    }
    if (lowerName.includes('count') || lowerName.includes('quantity') || lowerName.includes('age')) {
      return '3';
    }
    return '0';
  }
  if (t === 'boolean') {
    return lowerName.startsWith('is') ||
      lowerName.startsWith('has') ||
      lowerName === 'active' ||
      lowerName === 'enabled'
      ? 'true'
      : 'false';
  }
  if (t === 'null') {
    return 'null';
  }
  if (t === 'undefined') {
    return 'undefined';
  }
  if (t === 'Date') {
    return 'new Date()';
  }
  if (t === 'bigint') {
    return '0n';
  }
  if (/\[\]$/.test(t) || /^Array<.*>$/.test(t) || /^readonly .*\[\]$/.test(t)) {
    return '[]';
  }
  if (/^\(.*\)\s*=>/.test(t) || t === 'Function') {
    return '() => undefined';
  }
  if (/^Record<|^Map<|^\{/.test(t)) {
    return t.startsWith('Map<') ? 'new Map()' : '{}';
  }
  if (/^Promise<.*>$/.test(t)) {
    return 'Promise.resolve()';
  }
  const union = t
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (union.length > 1) {
    const first = union.find((u) => u !== 'undefined' && u !== 'null') ?? union[0];
    if (/^['"`]/.test(first)) {
      return first.replace(/^['"`]|['"`]$/g, (q) => (q ? quote : q));
    }
    return sampleValueForType(first, propName, quote);
  }
  if (/^['"`].*['"`]$/.test(t)) {
    return `${quote}${t.slice(1, -1)}${quote}`;
  }
  if (/^-?\d/.test(t)) {
    return t;
  }
  return 'undefined as unknown as ' + t;
}
