/**
 * TypeScript-specific AST payload stored in `CodeContext.ast` plus helpers used by commands.
 */
import * as ts from 'typescript';
import type { CodeContext } from '../../types/context';
import { CodePilotError } from '../../types/command';
import type { FunctionLikeNode } from '../../analyzer/astAnalyzer';

export interface TsAstContext {
  sourceFile: ts.SourceFile;
  nodeAtCursor: ts.Node;
  /** Node exactly matching the (trimmed) selection, if the selection aligns with a syntax node. */
  selectedNode?: ts.Node;
  /** Whole statements covered by the selection (empty when none). */
  selectedStatements: ts.Statement[];
  enclosingFunctionNode?: FunctionLikeNode;
  enclosingClassNode?: ts.ClassLikeDeclaration;
  enclosingStatementNode?: ts.Statement;
  topLevelStatementNode?: ts.Statement;
  enclosingComponentNode?: FunctionLikeNode;
  /** Lazily creates a single-file type checker. */
  getChecker(): ts.TypeChecker;
}

export function tsOf(ctx: CodeContext): TsAstContext {
  const ast = ctx.ast as TsAstContext | undefined;
  if (!ast || !ast.sourceFile) {
    throw new CodePilotError(
      'unsupportedLanguage',
      'This command only supports JavaScript and TypeScript files.',
    );
  }
  return ast;
}

/**
 * The expression represented by the selection:
 *  - an expression node matching the selection exactly, or
 *  - the expression of a single selected expression statement.
 */
export function getSelectedExpression(ctx: CodeContext): ts.Expression | undefined {
  const ast = tsOf(ctx);
  if (ctx.selection.kind === 'none') {
    return undefined;
  }
  const node = ast.selectedNode;
  if (node && ts.isExpression(node) && !ts.isJsxAttribute(node)) {
    return node;
  }
  if (node && ts.isExpressionStatement(node)) {
    return node.expression;
  }
  if (ast.selectedStatements.length === 1 && ts.isExpressionStatement(ast.selectedStatements[0])) {
    return ast.selectedStatements[0].expression;
  }
  return undefined;
}

/** Object literal from the selection, or the one enclosing the cursor when nothing is selected. */
export function getTargetObjectLiteral(ctx: CodeContext): ts.ObjectLiteralExpression | undefined {
  const ast = tsOf(ctx);
  const expr = getSelectedExpression(ctx);
  if (expr) {
    const unwrapped = unwrapExpression(expr);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return unwrapped;
    }
    return undefined;
  }
  const single = ast.selectedStatements.length === 1 ? ast.selectedStatements[0] : ast.selectedNode;
  if (single && ts.isVariableStatement(single)) {
    const init = single.declarationList.declarations[0]?.initializer;
    if (init && ts.isObjectLiteralExpression(unwrapExpression(init))) {
      return unwrapExpression(init) as ts.ObjectLiteralExpression;
    }
  }
  if (
    single &&
    ts.isVariableDeclaration(single) &&
    single.initializer &&
    ts.isObjectLiteralExpression(single.initializer)
  ) {
    return single.initializer;
  }
  if (ctx.selection.kind === 'none') {
    let current: ts.Node | undefined = ast.nodeAtCursor;
    while (current && !ts.isSourceFile(current)) {
      if (ts.isObjectLiteralExpression(current)) {
        return current;
      }
      if (ts.isFunctionLike(current) || ts.isClassLike(current)) {
        break;
      }
      current = current.parent;
    }
  }
  return undefined;
}

export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let node = expr;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** Variable name an object literal is assigned to (`const user = {...}` → `user`). */
export function getAssignedName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent) {
    return undefined;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = parent.left;
    if (ts.isIdentifier(left)) {
      return left.text;
    }
    if (ts.isPropertyAccessExpression(left)) {
      return left.name.text;
    }
  }
  if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    return getAssignedName(parent);
  }
  return undefined;
}

/** Declaration statement under the cursor or selected (function/class/interface/type/enum/variable). */
export function getTargetDeclaration(ctx: CodeContext): ts.Statement | undefined {
  const ast = tsOf(ctx);
  const isDecl = (s: ts.Node): s is ts.Statement =>
    ts.isFunctionDeclaration(s) ||
    ts.isClassDeclaration(s) ||
    ts.isInterfaceDeclaration(s) ||
    ts.isTypeAliasDeclaration(s) ||
    ts.isEnumDeclaration(s) ||
    ts.isVariableStatement(s) ||
    ts.isImportDeclaration(s);
  if (ast.selectedStatements.length === 1 && isDecl(ast.selectedStatements[0])) {
    return ast.selectedStatements[0];
  }
  if (ast.selectedNode && isDecl(ast.selectedNode)) {
    return ast.selectedNode;
  }
  if (ctx.selection.kind !== 'none') {
    return undefined;
  }
  let current: ts.Node | undefined = ast.nodeAtCursor;
  while (current && !ts.isSourceFile(current)) {
    if (isDecl(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

export function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset + 1) + ' ');
  const indent = match ? match[0] : '';
  // Do not count characters beyond the offset.
  return indent.length > offset - lineStart ? indent.slice(0, offset - lineStart) : indent;
}

export function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

export function lineEndOf(text: string, offset: number): number {
  const idx = text.indexOf('\n', offset);
  if (idx === -1) {
    return text.length;
  }
  return text[idx - 1] === '\r' ? idx - 1 : idx;
}
