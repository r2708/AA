import * as ts from 'typescript';
import type { CodeContext } from '../types/context';
import type { UndeclaredCall } from '../analyzer/astAnalyzer';
import { tsOf } from '../languages/typescript/tsContext';
import { checkerTypeText, inferTypeFromUsage } from '../analyzer/typeInference';
import { deriveNameFromExpression, uniqueName } from '../analyzer/naming';
import { escapeSnippet } from './codeWriter';

/** True when the file's top-level functions are mostly arrow functions assigned to consts. */
export function prefersArrowFunctions(ctx: CodeContext): boolean {
  const fns = ctx.declarations.functions.filter((f) => f.name);
  if (fns.length < 2) {
    return false;
  }
  const arrows = fns.filter((f) => f.isArrow).length;
  return arrows > fns.length / 2;
}

export interface StubParam {
  name: string;
  typeText: string;
}

/** Parameter list derived from the arguments of a call expression. */
export function paramsFromCallArguments(ctx: CodeContext, args: readonly ts.Expression[]): StubParam[] {
  const ast = tsOf(ctx);
  const used = new Set<string>();
  const params: StubParam[] = [];
  args.forEach((arg, index) => {
    let name: string;
    if (ts.isIdentifier(arg)) {
      name = arg.text;
    } else if (ts.isPropertyAccessExpression(arg)) {
      name = arg.name.text;
    } else if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      name = 'text';
    } else if (ts.isNumericLiteral(arg)) {
      name = 'value';
    } else if (ts.isObjectLiteralExpression(arg)) {
      name = 'options';
    } else if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      name = 'callback';
    } else if (ts.isSpreadElement(arg)) {
      name = 'args';
    } else {
      name = deriveNameFromExpression(arg, ast.sourceFile);
    }
    name = uniqueName(name || `arg${index}`, used);
    used.add(name);
    let typeText = 'unknown';
    if (ts.isSpreadElement(arg)) {
      typeText = 'unknown[]';
    } else if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      typeText = `(...args: unknown[]) => void`;
    } else {
      typeText =
        checkerTypeText(ast.getChecker(), arg) ??
        (ts.isIdentifier(arg)
          ? inferTypeFromUsage(arg.text, ast.enclosingFunctionNode ?? ast.sourceFile)
          : undefined) ??
        'unknown';
    }
    params.push({ name: ts.isSpreadElement(arg) ? `...${name}` : name, typeText });
  });
  return params;
}

/** Return type annotation for a stub created from `const x: T = await fn()` / `const x: T = fn()`. */
function returnTypeFromUsage(
  ctx: CodeContext,
  call: ts.CallExpression,
  isAwaited: boolean,
): string | undefined {
  const parent = isAwaited ? call.parent.parent : call.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.type) {
    const t = parent.type.getText(tsOf(ctx).sourceFile);
    return isAwaited ? `Promise<${t}>` : t;
  }
  if (parent && ts.isReturnStatement(parent)) {
    const fn = tsOf(ctx).enclosingFunctionNode;
    if (fn?.type) {
      return fn.type.getText(tsOf(ctx).sourceFile);
    }
  }
  return undefined;
}

/**
 * Snippet for a function stub matching an undeclared call:
 *   `const user = await getUser(id)` → `async function getUser(id: string) { $0 }`
 */
export function functionStubSnippet(ctx: CodeContext, call: UndeclaredCall): string {
  const isTs = ctx.language.isTypeScript;
  const params = paramsFromCallArguments(ctx, call.argumentNodes);
  let placeholder = 1;
  const paramText = params
    .map((p) => {
      if (!isTs) {
        return escapeSnippet(p.name);
      }
      const typePart = p.typeText === 'unknown' ? `\${${placeholder++}:unknown}` : escapeSnippet(p.typeText);
      return `${escapeSnippet(p.name)}: ${typePart}`;
    })
    .join(', ');
  const asyncPrefix = call.isAwaited ? 'async ' : '';
  let returnType = '';
  if (isTs) {
    const inferred = returnTypeFromUsage(ctx, call.call, call.isAwaited);
    if (inferred) {
      returnType = `: ${escapeSnippet(inferred)}`;
    } else if (call.isAwaited) {
      returnType = `: Promise<\${${placeholder++}:unknown}>`;
    }
  }
  const exportPrefix = '';
  return `${exportPrefix}${asyncPrefix}function ${escapeSnippet(call.name)}(${paramText})${returnType} {\n\t$0\n}`;
}

/** Generic function skeleton snippet, respecting arrow-function style. */
export function functionSkeletonSnippet(
  ctx: CodeContext,
  defaultName: string,
  options: { async?: boolean; exported?: boolean } = {},
): string {
  const semi = ctx.style.semicolons ? ';' : '';
  const asyncPrefix = options.async ? 'async ' : '';
  const exp = options.exported ? 'export ' : '';
  const ret = ctx.language.isTypeScript && options.async ? `: Promise<\${3:void}>` : '';
  if (prefersArrowFunctions(ctx)) {
    return `${exp}const \${1:${defaultName}} = ${asyncPrefix}(\${2})${ret} => {\n\t$0\n}${semi}`;
  }
  return `${exp}${asyncPrefix}function \${1:${defaultName}}(\${2})${ret} {\n\t$0\n}`;
}

/** Method skeleton for insertion inside a class body. */
export function methodSkeletonSnippet(
  ctx: CodeContext,
  defaultName: string,
  options: { async?: boolean; visibility?: string } = {},
): string {
  const asyncPrefix = options.async ? 'async ' : '';
  const vis = options.visibility && ctx.language.isTypeScript ? `${options.visibility} ` : '';
  const ret = ctx.language.isTypeScript ? (options.async ? `: Promise<\${3:void}>` : `\${3}`) : '';
  return `${vis}${asyncPrefix}\${1:${defaultName}}(\${2})${ret} {\n\t$0\n}`;
}
