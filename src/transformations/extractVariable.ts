/**
 * Extract Variable / Extract Constant.
 */
import * as ts from 'typescript';
import type { CodeContext } from '../types/context';
import { CodePilotError, type CommandResult, type TextEdit } from '../types/command';
import { collectValueReferences, getEnclosingStatement } from '../analyzer/astAnalyzer';
import {
  getSelectedExpression,
  lineIndentAt,
  tsOf,
  unwrapExpression,
} from '../languages/typescript/tsContext';
import { deriveConstantName, deriveNameFromExpression, uniqueName } from '../analyzer/naming';
import { checkerTypeText } from '../analyzer/typeInference';
import { semi, typeAnnotation } from '../generators/codeWriter';
import { planAfterImports } from './insertion';

export interface ExtractVariableOptions {
  name?: string;
  /** Emit an explicit type annotation when inferable (TypeScript only). */
  annotate?: boolean;
}

function requireExpression(ctx: CodeContext): ts.Expression {
  const expr = getSelectedExpression(ctx);
  if (!expr) {
    throw new CodePilotError(
      'invalidSelection',
      'Select an expression to extract (for example `user.profile.name`).',
    );
  }
  if (ts.isJsxAttribute(expr as ts.Node)) {
    throw new CodePilotError(
      'invalidSelection',
      'Select the attribute value expression rather than the whole attribute.',
    );
  }
  return expr;
}

function isDirectInitializer(expr: ts.Expression): boolean {
  return !!expr.parent && ts.isVariableDeclaration(expr.parent) && expr.parent.initializer === expr;
}

export function extractVariable(ctx: CodeContext, options: ExtractVariableOptions = {}): CommandResult {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const expr = requireExpression(ctx);
  if (isDirectInitializer(expr)) {
    const existing = (expr.parent as ts.VariableDeclaration).name.getText(sf);
    throw new CodePilotError(
      'invalidTransformation',
      `This expression is already assigned to \`${existing}\`.`,
    );
  }
  if (ts.isExpressionStatement(expr.parent) && ast.selectedStatements.length === 1) {
    // Selected a whole expression statement: convert into a declaration in place.
    const name = uniqueName(options.name ?? deriveNameFromExpression(expr, sf), ctx.scope.visibleNames);
    const stmt = ast.selectedStatements[0];
    const type = options.annotate ? checkerTypeText(ast.getChecker(), expr) : undefined;
    const text = `const ${name}${typeAnnotation(ctx, type)} = ${expr.getText(sf)}${semi(ctx)}`;
    return {
      edits: [{ range: { start: stmt.getStart(sf), end: stmt.getEnd() }, text }],
      message: `Assigned the expression to const ${name}`,
    };
  }
  const stmt = getEnclosingStatement(expr);
  if (!stmt) {
    throw new CodePilotError(
      'invalidTransformation',
      'Could not find a statement to insert the variable before.',
    );
  }
  if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
    throw new CodePilotError(
      'invalidTransformation',
      'Cannot extract a variable from a class member initializer.',
    );
  }
  const name = uniqueName(options.name ?? deriveNameFromExpression(expr, sf), ctx.scope.visibleNames);
  const stmtStart = stmt.getStart(sf);
  const indent = lineIndentAt(ctx.text, stmtStart);
  const type = options.annotate ? checkerTypeText(ast.getChecker(), expr) : undefined;
  const exprText = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
  const declaration = `const ${name}${typeAnnotation(ctx, type)} = ${exprText}${semi(ctx)}${ctx.eol}${indent}`;
  const edits: TextEdit[] = [
    { range: { start: stmtStart, end: stmtStart }, text: declaration },
    { range: ctx.selection.range, text: name },
  ];
  return {
    edits,
    message: `Extracted \`${exprText.length > 40 ? exprText.slice(0, 37) + '...' : exprText}\` into const ${name}`,
  };
}

function isLiteralLike(expr: ts.Expression): boolean {
  const e = unwrapExpression(expr);
  if (
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isRegularExpressionLiteral(e) ||
    ts.isBigIntLiteral(e)
  ) {
    return true;
  }
  if (
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) {
    return true;
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.every((el) => isLiteralLike(el as ts.Expression));
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) => ts.isPropertyAssignment(p) && isLiteralLike(p.initializer));
  }
  if (ts.isTemplateExpression(e)) {
    return false;
  }
  return false;
}

/** True when the expression only references module-level bindings (safe to hoist). */
export function canHoistToModuleScope(ctx: CodeContext, expr: ts.Expression): boolean {
  const refs = collectValueReferences(expr);
  for (const name of refs.keys()) {
    if (!ctx.declarations.topLevelNames.has(name)) {
      return false;
    }
  }
  return !/\bthis\b/.test(expr.getText(tsOf(ctx).sourceFile));
}

export function extractConstant(ctx: CodeContext, options: ExtractVariableOptions = {}): CommandResult {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const expr = requireExpression(ctx);
  const literal = isLiteralLike(expr);
  if (!literal && !canHoistToModuleScope(ctx, expr)) {
    // Falls back to a local const with a camelCase name.
    const result = extractVariable(ctx, options);
    return {
      ...result,
      message: `${result.message ?? ''} (kept local because the expression uses local variables)`,
    };
  }
  const base = options.name ?? deriveConstantName(expr, sf);
  const name = uniqueName(base, new Set([...ctx.declarations.topLevelNames, ...ctx.scope.visibleNames]));
  const exprText = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
  const plan = planAfterImports(ctx);
  const declaration = `${plan.prefix}const ${name} = ${exprText}${semi(ctx)}${plan.suffix}`;
  const edits: TextEdit[] = [
    { range: plan.range, text: declaration },
    { range: ctx.selection.range, text: name },
  ];
  // Replace other identical literal occurrences in the file (same text, literal only, outside imports).
  let extra = 0;
  if (
    literal &&
    (ts.isStringLiteral(unwrapExpression(expr)) || ts.isNumericLiteral(unwrapExpression(expr)))
  ) {
    const visit = (node: ts.Node): void => {
      if (
        node !== expr &&
        (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) &&
        node.getText(sf) === exprText &&
        !ts.isImportDeclaration(node.parent) &&
        !ts.isPropertyAssignment(node.parent) &&
        !(
          ts.isPropertyAccessExpression(node.parent) ||
          (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression !== node)
        ) &&
        !ts.isLiteralTypeNode(node.parent) &&
        !ts.isEnumMember(node.parent) &&
        !(ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent))
      ) {
        edits.push({ range: { start: node.getStart(sf), end: node.getEnd() }, text: name });
        extra += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const detail = extra > 0 ? ` and replaced ${extra} other occurrence${extra === 1 ? '' : 's'}` : '';
  return {
    edits,
    message: `Extracted ${exprText.length > 40 ? exprText.slice(0, 37) + '...' : exprText} into constant ${name}${detail}`,
  };
}
