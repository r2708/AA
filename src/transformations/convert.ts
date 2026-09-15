/**
 * Small deterministic expression/statement conversions:
 *  - if/else → ternary
 *  - `a || b` → `a ?? b`
 *  - `a.b.c` → `a?.b?.c`
 *  - `promise.then(x => ...)` → `const x = await promise; ...`
 */
import * as ts from 'typescript';
import type { CodeContext } from '../types/context';
import { tsOf } from '../languages/typescript/tsContext';

function singleStatement(node: ts.Statement | undefined): ts.Statement | undefined {
  if (!node) {
    return undefined;
  }
  if (ts.isBlock(node)) {
    return node.statements.length === 1 ? node.statements[0] : undefined;
  }
  return node;
}

/** `if (c) { return a; } else { return b; }` → `return c ? a : b;` (also assignments). */
export function ifElseToTernary(ctx: CodeContext, stmt: ts.IfStatement): string | undefined {
  const sf = tsOf(ctx).sourceFile;
  const semi = ctx.style.semicolons ? ';' : '';
  const thenStmt = singleStatement(stmt.thenStatement);
  const elseStmt = singleStatement(stmt.elseStatement);
  if (!thenStmt || !elseStmt) {
    return undefined;
  }
  const cond = stmt.expression.getText(sf);
  if (
    ts.isReturnStatement(thenStmt) &&
    ts.isReturnStatement(elseStmt) &&
    thenStmt.expression &&
    elseStmt.expression
  ) {
    return `return ${cond} ? ${thenStmt.expression.getText(sf)} : ${elseStmt.expression.getText(sf)}${semi}`;
  }
  if (
    ts.isExpressionStatement(thenStmt) &&
    ts.isExpressionStatement(elseStmt) &&
    ts.isBinaryExpression(thenStmt.expression) &&
    ts.isBinaryExpression(elseStmt.expression) &&
    thenStmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    elseStmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    thenStmt.expression.left.getText(sf) === elseStmt.expression.left.getText(sf)
  ) {
    return `${thenStmt.expression.left.getText(sf)} = ${cond} ? ${thenStmt.expression.right.getText(sf)} : ${elseStmt.expression.right.getText(sf)}${semi}`;
  }
  return undefined;
}

function isRootLike(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.ThisKeyword ||
    node.kind === ts.SyntaxKind.SuperKeyword ||
    (ts.isIdentifier(node) &&
      /^(window|document|globalThis|process|console|Math|JSON|Object|Array|Number|String|Promise|Date)$/.test(
        node.text,
      )) ||
    ts.isMetaProperty(node)
  );
}

/** Rewrites a member access chain with optional chaining: `a.b.c()` → `a?.b?.c()`. */
export function toOptionalChain(ctx: CodeContext, expr: ts.Expression): string {
  const sf = tsOf(ctx).sourceFile;
  const build = (node: ts.Expression, isFirstAccess: boolean): string => {
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.expression;
      const inner = build(target, false);
      const optional = isRootLike(target) ? '.' : '?.';
      return `${inner}${optional}${node.name.text}`;
    }
    if (ts.isElementAccessExpression(node)) {
      const target = node.expression;
      const inner = build(target, false);
      const optional = isRootLike(target) ? '' : '?.';
      return `${inner}${optional}[${node.argumentExpression.getText(sf)}]`;
    }
    if (ts.isCallExpression(node)) {
      const inner = build(node.expression, false);
      const args = node.arguments.map((a) => a.getText(sf)).join(', ');
      const typeArgs = node.typeArguments
        ? `<${node.typeArguments.map((t) => t.getText(sf)).join(', ')}>`
        : '';
      return `${inner}${typeArgs}(${args})`;
    }
    if (ts.isNonNullExpression(node)) {
      return build(node.expression, isFirstAccess);
    }
    if (ts.isParenthesizedExpression(node)) {
      return `(${build(node.expression, isFirstAccess)})`;
    }
    return node.getText(sf);
  };
  return build(expr, true);
}

/** `a || b` → `a ?? b` when the left side is not a boolean-ish comparison. */
export function orToNullish(ctx: CodeContext, expr: ts.Expression): string | undefined {
  const sf = tsOf(ctx).sourceFile;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return `${expr.left.getText(sf)} ?? ${expr.right.getText(sf)}`;
  }
  return undefined;
}

export interface ThenConversion {
  /** Replacement code for the whole expression statement (template code). */
  code: string;
}

/**
 * `promise.then((value) => { body })` (as an expression statement) →
 * `const value = await promise;` followed by the callback body.
 */
export function thenToAwait(ctx: CodeContext, stmt: ts.ExpressionStatement): ThenConversion | undefined {
  const sf = tsOf(ctx).sourceFile;
  const semi = ctx.style.semicolons ? ';' : '';
  const call = stmt.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'then'
  ) {
    return undefined;
  }
  if (call.arguments.length !== 1) {
    return undefined;
  }
  const cb = call.arguments[0];
  if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) {
    return undefined;
  }
  if (cb.parameters.length > 1) {
    return undefined;
  }
  const promiseText = call.expression.expression.getText(sf);
  const param = cb.parameters[0];
  const paramName =
    param && ts.isIdentifier(param.name) ? param.name.text : param ? param.name.getText(sf) : undefined;
  const lines: string[] = [];
  lines.push(paramName ? `const ${paramName} = await ${promiseText}${semi}` : `await ${promiseText}${semi}`);
  if (ts.isBlock(cb.body)) {
    const bodyText = cb.body.statements.map((s) => s.getText(sf)).join('\n');
    if (bodyText.trim()) {
      lines.push(bodyText);
    }
  } else {
    lines.push(`${cb.body.getText(sf)}${semi}`);
  }
  return { code: lines.join('\n') };
}
