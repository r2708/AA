/**
 * Generates object literals with sample values from interfaces / type literals
 * (Create Object, Generate Test Data, Generate Mock Data).
 */
import type { CodeContext, InterfaceInfo, PropertyInfo, TypeAliasInfo } from '../types/context';
import { sampleValueForType } from '../analyzer/typeInference';

export interface NamedShape {
  name: string;
  members: PropertyInfo[];
}

export function shapeFromDeclaration(decl: InterfaceInfo | TypeAliasInfo): NamedShape | undefined {
  if (decl.kind === 'interface') {
    return { name: decl.name, members: (decl as InterfaceInfo).members };
  }
  const alias = decl as TypeAliasInfo;
  if (alias.members) {
    return { name: alias.name, members: alias.members };
  }
  return undefined;
}

/** Resolves a type name to a nested shape declared in the same file. */
function resolveNested(ctx: CodeContext, typeText: string | undefined): NamedShape | undefined {
  if (!typeText) {
    return undefined;
  }
  const clean = typeText.replace(/\[\]$/, '').trim();
  const iface = ctx.declarations.interfaces.find((i) => i.name === clean);
  if (iface) {
    return { name: iface.name, members: iface.members };
  }
  const alias = ctx.declarations.types.find((t) => t.name === clean && t.members);
  if (alias?.members) {
    return { name: alias.name, members: alias.members };
  }
  return undefined;
}

function memberLines(ctx: CodeContext, shape: NamedShape, includeOptional: boolean, depth: number): string[] {
  const q = ctx.style.quote;
  const lines: string[] = [];
  for (const m of shape.members) {
    if (m.optional && !includeOptional) {
      continue;
    }
    const isArray = !!m.typeText && /\[\]$/.test(m.typeText);
    const nested = depth < 3 ? resolveNested(ctx, m.typeText) : undefined;
    let value: string;
    if (nested && !isArray) {
      value = objectLiteralForShape(ctx, nested, includeOptional, depth + 1);
    } else if (nested && isArray) {
      value = `[${objectLiteralForShape(ctx, nested, includeOptional, depth + 1)}]`;
    } else {
      value = sampleValueForType(m.typeText, m.name, q);
    }
    lines.push(`${m.name}: ${indentNested(value)},`);
  }
  return lines;
}

/**
 * Object literal (template code, `\t`-indented) with sample values for a shape.
 * `depth` guards against recursive types.
 */
export function objectLiteralForShape(
  ctx: CodeContext,
  shape: NamedShape,
  includeOptional: boolean,
  depth = 0,
): string {
  const lines = memberLines(ctx, shape, includeOptional, depth);
  if (lines.length === 0) {
    return '{}';
  }
  return `{\n${lines.map((l) => `\t${l}`).join('\n')}\n}`;
}

function indentNested(value: string): string {
  return value
    .split('\n')
    .map((line, i) => (i === 0 ? line : `\t${line}`))
    .join('\n');
}

/** Mock factory: `createMockUser(overrides: Partial<User> = {}): User`. */
export function mockFactoryCode(ctx: CodeContext, shape: NamedShape): string {
  const isTs = ctx.language.isTypeScript;
  const semi = ctx.style.semicolons ? ';' : '';
  const lines = memberLines(ctx, shape, true, 0).map((l) => `\t\t${l}`);
  const params = isTs ? `overrides: Partial<${shape.name}> = {}` : 'overrides = {}';
  const ret = isTs ? `: ${shape.name}` : '';
  return `export function createMock${shape.name}(${params})${ret} {\n\treturn {\n${lines.join('\n')}\n\t\t...overrides,\n\t}${semi}\n}`;
}
