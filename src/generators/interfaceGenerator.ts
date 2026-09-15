/**
 * Infers structural types from object literals and emits interfaces, type aliases
 * or JSDoc typedefs (for JavaScript files).
 */
import * as ts from 'typescript';
import type { CodeContext, PropertyInfo } from '../types/context';
import { tsOf } from '../languages/typescript/tsContext';
import { checkerTypeText, literalTypeText } from '../analyzer/typeInference';
import { singularize, toPascalCase, uniqueName, isValidIdentifier } from '../analyzer/naming';

export type TypeDesc =
  | { kind: 'text'; text: string }
  | { kind: 'object'; shape: Shape }
  | { kind: 'array'; element: TypeDesc }
  | { kind: 'union'; members: TypeDesc[] };

export interface ShapeProp {
  name: string;
  type: TypeDesc;
  optional: boolean;
}

export interface Shape {
  props: ShapeProp[];
}

function text(t: string): TypeDesc {
  return { kind: 'text', text: t };
}

function unionOf(members: TypeDesc[]): TypeDesc {
  const flat: TypeDesc[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const items = m.kind === 'union' ? m.members : [m];
    for (const item of items) {
      const key = keyOf(item);
      if (!seen.has(key)) {
        seen.add(key);
        flat.push(item);
      }
    }
  }
  if (flat.length === 0) {
    return text('unknown');
  }
  const objects = flat.filter((f): f is { kind: 'object'; shape: Shape } => f.kind === 'object');
  if (objects.length > 1) {
    const merged = mergeShapes(objects.map((o) => o.shape));
    const rest = flat.filter((f) => f.kind !== 'object');
    return rest.length
      ? { kind: 'union', members: [{ kind: 'object', shape: merged }, ...rest] }
      : { kind: 'object', shape: merged };
  }
  return flat.length === 1 ? flat[0] : { kind: 'union', members: flat };
}

function keyOf(t: TypeDesc): string {
  switch (t.kind) {
    case 'text':
      return t.text;
    case 'array':
      return `${keyOf(t.element)}[]`;
    case 'union':
      return t.members.map(keyOf).sort().join('|');
    case 'object':
      return `{${t.shape.props.map((p) => `${p.name}${p.optional ? '?' : ''}:${keyOf(p.type)}`).join(';')}}`;
  }
}

/** Merges object shapes: properties missing from some become optional, differing types union. */
export function mergeShapes(shapes: Shape[]): Shape {
  const order: string[] = [];
  const byName = new Map<string, { types: TypeDesc[]; count: number; optional: boolean }>();
  for (const shape of shapes) {
    for (const prop of shape.props) {
      if (!byName.has(prop.name)) {
        byName.set(prop.name, { types: [], count: 0, optional: false });
        order.push(prop.name);
      }
      const entry = byName.get(prop.name) as { types: TypeDesc[]; count: number; optional: boolean };
      entry.types.push(prop.type);
      entry.count += 1;
      entry.optional = entry.optional || prop.optional;
    }
  }
  return {
    props: order.map((name) => {
      const entry = byName.get(name) as { types: TypeDesc[]; count: number; optional: boolean };
      return { name, type: unionOf(entry.types), optional: entry.optional || entry.count < shapes.length };
    }),
  };
}

export interface InferenceOptions {
  sf: ts.SourceFile;
  getChecker?: () => ts.TypeChecker;
}

export function typeDescOfExpression(
  expr: ts.Expression,
  opts: InferenceOptions,
): { type: TypeDesc; optional: boolean } {
  let node = expr;
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return { type: text(node.type.getText(opts.sf)), optional: false };
  }
  if (ts.isObjectLiteralExpression(node)) {
    return { type: { kind: 'object', shape: shapeFromObjectLiteral(node, opts) }, optional: false };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const elements = node.elements.filter((e) => !ts.isSpreadElement(e) && !ts.isOmittedExpression(e));
    if (elements.length === 0) {
      return { type: { kind: 'array', element: text('unknown') }, optional: false };
    }
    return {
      type: { kind: 'array', element: unionOf(elements.map((e) => typeDescOfExpression(e, opts).type)) },
      optional: false,
    };
  }
  if (ts.isIdentifier(node) && node.text === 'undefined') {
    return { type: text('unknown'), optional: true };
  }
  if (ts.isConditionalExpression(node)) {
    const a = typeDescOfExpression(node.whenTrue, opts);
    const b = typeDescOfExpression(node.whenFalse, opts);
    return { type: unionOf([a.type, b.type]), optional: a.optional || b.optional };
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const a = typeDescOfExpression(node.left, opts);
    const b = typeDescOfExpression(node.right, opts);
    return {
      type: unionOf(
        [a.type, b.type].filter((t) => !(t.kind === 'text' && (t.text === 'null' || t.text === 'undefined'))),
      ),
      optional: false,
    };
  }
  const literal = literalTypeText(node);
  if (literal) {
    return { type: text(literal), optional: false };
  }
  if (opts.getChecker) {
    const fromChecker = checkerTypeText(opts.getChecker(), node);
    if (fromChecker) {
      return { type: text(fromChecker), optional: false };
    }
  }
  if (ts.isAwaitExpression(node)) {
    return { type: text('unknown'), optional: false };
  }
  return { type: text('unknown'), optional: false };
}

export function shapeFromObjectLiteral(obj: ts.ObjectLiteralExpression, opts: InferenceOptions): Shape {
  const props: ShapeProp[] = [];
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
          ? prop.name.text
          : undefined;
      if (name === undefined) {
        continue; // computed key
      }
      const { type, optional } = typeDescOfExpression(prop.initializer, opts);
      props.push({ name, type, optional });
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      let type: TypeDesc = text('unknown');
      if (opts.getChecker) {
        const t = checkerTypeText(opts.getChecker(), prop.name);
        if (t) {
          type = text(t);
        }
      }
      props.push({ name: prop.name.text, type, optional: false });
    } else if (
      ts.isMethodDeclaration(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      const params = prop.parameters
        .map((p) => `${p.name.getText(opts.sf)}: ${p.type ? p.type.getText(opts.sf) : 'unknown'}`)
        .join(', ');
      const ret = prop.type ? prop.type.getText(opts.sf) : 'void';
      props.push({ name: prop.name.text, type: text(`(${params}) => ${ret}`), optional: false });
    }
  }
  return { props };
}

export function shapeFromMembers(members: PropertyInfo[]): Shape {
  return {
    props: members.map((m) => ({ name: m.name, type: text(m.typeText ?? 'unknown'), optional: m.optional })),
  };
}

export interface EmitOptions {
  kind: 'interface' | 'type' | 'jsdoc';
  exported: boolean;
  semi: string;
  /** Names already used in the file; nested names are made unique and added here. */
  existingNames: Set<string>;
}

export interface EmittedType {
  /** Root type name. */
  name: string;
  /** Template code (`\t`/`\n` based). Nested types come first. */
  code: string;
  names: string[];
}

function propertyKey(name: string): string {
  return isValidIdentifier(name) || /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? name
    : `'${name.replace(/'/g, "\\'")}'`;
}

/**
 * Emits a named type for a shape. Nested object shapes are hoisted into their own
 * named types (`User` + `UserAddress`), arrays of objects use singular names (`UserItem`).
 */
export function emitShape(shape: Shape, rootName: string, opts: EmitOptions): EmittedType {
  const blocks: string[] = [];
  const names: string[] = [];

  const renderType = (t: TypeDesc, nameHint: string): string => {
    switch (t.kind) {
      case 'text':
        return t.text;
      case 'array': {
        const inner = renderType(t.element, singularize(nameHint));
        return t.element.kind === 'union' || /\s\|\s/.test(inner) || inner.includes('=>')
          ? `(${inner})[]`
          : `${inner}[]`;
      }
      case 'union':
        return t.members.map((m) => renderType(m, nameHint)).join(' | ');
      case 'object': {
        if (t.shape.props.length === 0) {
          return 'Record<string, unknown>';
        }
        const nested = uniqueName(nameHint, opts.existingNames);
        opts.existingNames.add(nested);
        emitNamed(t.shape, nested);
        return nested;
      }
    }
  };

  const emitNamed = (s: Shape, name: string): void => {
    const lines = s.props.map((p) => {
      const typeText = renderType(p.type, toPascalCase(`${name} ${p.name}`));
      return { key: propertyKey(p.name), typeText, optional: p.optional };
    });
    names.push(name);
    const exp = opts.exported ? 'export ' : '';
    if (opts.kind === 'jsdoc') {
      const body = lines
        .map((l) => ` * @property {${l.typeText}} ${l.optional ? `[${l.key}]` : l.key}`)
        .join('\n');
      blocks.push(`/**\n * @typedef {Object} ${name}\n${body}\n */`);
      return;
    }
    const body = lines.map((l) => `\t${l.key}${l.optional ? '?' : ''}: ${l.typeText}${opts.semi}`).join('\n');
    if (opts.kind === 'interface') {
      blocks.push(`${exp}interface ${name} {\n${body}\n}`);
    } else {
      blocks.push(`${exp}type ${name} = {\n${body}\n}${opts.semi}`);
    }
  };

  emitNamed(shape, rootName);
  // Nested types are pushed while their parent's members are rendered, so dependencies come first.
  return { name: rootName, code: blocks.join('\n\n'), names };
}

/** Convenience: object literal → emitted interface/type. */
export function generateTypeFromObjectLiteral(
  ctx: CodeContext,
  obj: ts.ObjectLiteralExpression,
  rootName: string,
  kind: EmitOptions['kind'],
  exported = false,
): EmittedType {
  const ast = tsOf(ctx);
  const shape = shapeFromObjectLiteral(obj, { sf: ast.sourceFile, getChecker: ast.getChecker });
  const existing = new Set(ctx.declarations.topLevelNames);
  existing.add(rootName);
  return emitShape(shape, rootName, {
    kind,
    exported,
    semi: ctx.style.semicolons ? ';' : '',
    existingNames: existing,
  });
}
