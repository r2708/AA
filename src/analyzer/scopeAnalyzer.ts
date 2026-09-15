import * as ts from 'typescript';
import type {
  ClassInfo,
  IndentInfo,
  InterfaceInfo,
  MethodInfo,
  ScopeInfo,
  ScopeKind,
} from '../types/context';
import {
  findAncestor,
  getClassInfo,
  getEnclosingClass,
  getEnclosingFunction,
  getEnclosingStatement,
  getFunctionInfo,
  getInterfaceInfo,
  getTopLevelStatement,
  getVisibleNames,
  isFunctionLikeNode,
  rangeOf,
} from './astAnalyzer';
import { lineIndentAt } from '../languages/typescript/tsContext';

/** Innermost node that owns a statement list / member list around the cursor. */
function nearestContainer(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      ts.isClassLike(current) ||
      ts.isObjectLiteralExpression(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeLiteralNode(current) ||
      ts.isEnumDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

function scopeKindOf(node: ts.Node): ScopeKind {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isSourceFile(current)) {
      return 'module';
    }
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current) ||
      ts.isJsxAttribute(current)
    ) {
      return 'jsx';
    }
    if (ts.isObjectLiteralExpression(current)) {
      return 'object';
    }
    if (ts.isInterfaceDeclaration(current) || ts.isTypeLiteralNode(current)) {
      return 'interface';
    }
    if (
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return 'method';
    }
    if (isFunctionLikeNode(current)) {
      return 'function';
    }
    if (ts.isClassLike(current)) {
      return 'class';
    }
    current = current.parent;
  }
  return 'unknown';
}

/** Indentation for a new statement/member inserted at the cursor. */
export function computeStatementIndent(sf: ts.SourceFile, node: ts.Node, indent: IndentInfo): string {
  const container = nearestContainer(node);
  if (ts.isSourceFile(container)) {
    return '';
  }
  const text = sf.text;
  let openBracePos: number;
  if (ts.isCaseClause(container) || ts.isDefaultClause(container)) {
    openBracePos = container.getStart(sf);
  } else if (
    ts.isClassLike(container) ||
    ts.isInterfaceDeclaration(container) ||
    ts.isEnumDeclaration(container)
  ) {
    openBracePos = container.members.pos - 1;
  } else if (ts.isObjectLiteralExpression(container)) {
    openBracePos = container.properties.pos - 1;
  } else if (ts.isTypeLiteralNode(container)) {
    openBracePos = container.members.pos - 1;
  } else {
    openBracePos = container.getStart(sf);
  }
  const baseIndent = lineIndentAt(text, openBracePos);
  return baseIndent + indent.unit;
}

export function analyzeScope(sf: ts.SourceFile, nodeAtCursor: ts.Node, indent: IndentInfo): ScopeInfo {
  const fnNode = getEnclosingFunction(nodeAtCursor);
  const classNode = getEnclosingClass(nodeAtCursor);
  const kind = scopeKindOf(nodeAtCursor);
  const fnInfo = fnNode ? getFunctionInfo(fnNode, sf) : undefined;
  let classInfo: ClassInfo | undefined;
  if (classNode) {
    classInfo = getClassInfo(classNode, sf);
  }
  let methodInfo: MethodInfo | undefined;
  if (fnNode && (ts.isMethodDeclaration(fnNode) || ts.isConstructorDeclaration(fnNode)) && classInfo) {
    methodInfo = classInfo.methods.find((m) => m.range.start === fnNode.getStart(sf)) ?? {
      ...(fnInfo as MethodInfo),
      isStatic: false,
    };
  }
  const interfaceNode = findAncestor(nodeAtCursor, ts.isInterfaceDeclaration);
  const interfaceInfo: InterfaceInfo | undefined = interfaceNode
    ? getInterfaceInfo(interfaceNode, sf)
    : undefined;
  const catchClause = findAncestor(nodeAtCursor, ts.isCatchClause);
  const inCatchClause = !!catchClause && (!fnNode || fnNode.getStart(sf) < catchClause.getStart(sf));
  const stmt = getEnclosingStatement(nodeAtCursor);
  const top = getTopLevelStatement(nodeAtCursor);

  // Directly inside the class body means the nearest function/class ancestor is the class.
  let inClassBody = false;
  if (classNode) {
    const nearestFn = fnNode;
    inClassBody =
      !nearestFn ||
      nearestFn.getStart(sf) < classNode.getStart(sf) ||
      nearestFn.getEnd() > classNode.getEnd();
    if (
      nearestFn &&
      classNode.getStart(sf) < nearestFn.getStart(sf) &&
      nearestFn.getEnd() <= classNode.getEnd()
    ) {
      inClassBody = false;
    }
  }

  return {
    kind,
    isAsync: !!fnInfo?.isAsync,
    isGenerator: !!fnInfo?.isGenerator,
    enclosingFunction: fnInfo,
    enclosingClass: classInfo,
    enclosingMethod: methodInfo,
    enclosingInterface: interfaceInfo,
    enclosingStatement: stmt ? rangeOf(stmt, sf) : undefined,
    topLevelStatement: top ? rangeOf(top, sf) : undefined,
    inClassBody,
    inObjectLiteral: kind === 'object',
    inInterfaceBody: kind === 'interface',
    inJsx: kind === 'jsx',
    inCatchClause,
    catchVariableName:
      inCatchClause &&
      catchClause?.variableDeclaration &&
      ts.isIdentifier(catchClause.variableDeclaration.name)
        ? catchClause.variableDeclaration.name.text
        : undefined,
    visibleNames: getVisibleNames(nodeAtCursor, sf),
    statementIndent: computeStatementIndent(sf, nodeAtCursor, indent),
  };
}
