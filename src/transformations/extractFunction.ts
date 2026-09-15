/**
 * Extract Function / Extract Method.
 *
 * Analyses the selected statements (or expression): which outer variables it reads
 * (→ parameters, with inferred types), which variables it declares that are used
 * afterwards (→ return value), whether it awaits (→ async), whether it uses `this`
 * (→ class method). Produces plain text edits so the result is deterministic.
 */
import * as ts from 'typescript';
import type { CodeContext } from '../types/context';
import { CodePilotError, type CommandResult, type TextEdit } from '../types/command';
import {
  collectBindingNames,
  collectDeclaredNames,
  collectValueReferences,
  containsAwait,
  containsKind,
  getEnclosingStatement,
  getTopLevelStatement,
  isFunctionLikeNode,
} from '../analyzer/astAnalyzer';
import { getSelectedExpression, lineIndentAt, tsOf } from '../languages/typescript/tsContext';
import { checkerTypeText, inferTypeFromUsage } from '../analyzer/typeInference';
import { deriveFunctionName, deriveNameFromExpression, uniqueName, capitalize } from '../analyzer/naming';
import { dedentSubsequentLines, indentAllLines, renderCode, semi } from '../generators/codeWriter';
import { planClassMemberInsertion, planTopLevelInsertion } from './insertion';

export interface ExtractionParam {
  name: string;
  typeText: string;
}

export interface ExtractionAnalysis {
  kind: 'statements' | 'expression';
  params: ExtractionParam[];
  /** Variables declared inside the selection that are used after it. */
  returns: { name: string; declarationKind: 'const' | 'let' | 'var' }[];
  isAsync: boolean;
  usesThis: boolean;
  endsWithReturn: boolean;
  hasConditionalReturn: boolean;
  suggestedName: string;
  asMethod: boolean;
}

function typeForParam(ctx: CodeContext, name: string, refs: ts.Identifier[], root: ts.Node): string {
  const ast = tsOf(ctx);
  const first = refs[0];
  const fromChecker = first ? checkerTypeText(ast.getChecker(), first) : undefined;
  if (fromChecker) {
    return fromChecker;
  }
  const fromUsage = inferTypeFromUsage(name, root);
  if (fromUsage) {
    return fromUsage;
  }
  // Declared type annotation of an enclosing parameter / variable.
  const fn = ast.enclosingFunctionNode;
  if (fn) {
    const param = fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (param?.type) {
      return param.type.getText(ast.sourceFile);
    }
  }
  return 'unknown';
}

function declaredInEnclosingScopes(nodes: readonly ts.Node[]): Set<string> {
  const names = new Set<string>();
  let current: ts.Node | undefined = nodes[0]?.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionLikeNode(current)) {
      for (const p of current.parameters) {
        collectDeclaredNames(p, names);
      }
      if (current.body) {
        collectDeclaredNames(current.body, names);
      }
    } else if (
      ts.isBlock(current) ||
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isCatchClause(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      collectDeclaredNames(current, names);
    }
    current = current.parent;
  }
  return names;
}

function declarationKindOf(name: string, statements: readonly ts.Statement[]): 'const' | 'let' | 'var' {
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (collectBindingNames(d.name).includes(name)) {
          if (s.declarationList.flags & ts.NodeFlags.Const) {
            return 'const';
          }
          if (s.declarationList.flags & ts.NodeFlags.Let) {
            return 'let';
          }
          return 'var';
        }
      }
    }
  }
  return 'const';
}

/** Names declared directly by the selected statements (not inside nested blocks/functions). */
function directlyDeclared(statements: readonly ts.Statement[]): string[] {
  const names: string[] = [];
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        names.push(...collectBindingNames(d.name));
      }
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) {
      names.push(s.name.text);
    }
  }
  return names;
}

function usedAfter(ctx: CodeContext, names: string[], statements: readonly ts.Statement[]): string[] {
  if (names.length === 0) {
    return [];
  }
  const last = statements[statements.length - 1];
  const container = last.parent;
  const siblings: readonly ts.Statement[] =
    ts.isBlock(container) ||
    ts.isSourceFile(container) ||
    ts.isCaseClause(container) ||
    ts.isDefaultClause(container) ||
    ts.isModuleBlock(container)
      ? container.statements
      : [];
  const after = siblings.filter((s) => s.getStart(tsOf(ctx).sourceFile) >= last.getEnd());
  const used = new Set<string>();
  for (const s of after) {
    const refs = collectValueReferences(s);
    for (const n of names) {
      if (refs.has(n)) {
        used.add(n);
      }
    }
  }
  return names.filter((n) => used.has(n));
}

export function analyzeExtraction(ctx: CodeContext): ExtractionAnalysis {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const statements = ast.selectedStatements;
  const expression = statements.length === 0 ? getSelectedExpression(ctx) : undefined;
  if (statements.length === 0 && !expression) {
    throw new CodePilotError(
      'invalidSelection',
      'Select one or more complete statements (or a single expression) to extract.',
    );
  }
  const roots: ts.Node[] = statements.length ? statements : [expression as ts.Expression];
  const declaredInside = new Set<string>();
  roots.forEach((r) => collectDeclaredNames(r, declaredInside));
  const outerNames = declaredInEnclosingScopes(roots);
  const refs = new Map<string, ts.Identifier[]>();
  for (const r of roots) {
    for (const [name, ids] of collectValueReferences(r)) {
      if (!refs.has(name)) {
        refs.set(name, []);
      }
      (refs.get(name) as ts.Identifier[]).push(...ids);
    }
  }
  const params: ExtractionParam[] = [];
  for (const [name, ids] of refs) {
    if (declaredInside.has(name) || !outerNames.has(name)) {
      continue;
    }
    params.push({
      name,
      typeText: typeForParam(ctx, name, ids, roots.length === 1 ? roots[0] : roots[0].parent),
    });
  }
  const usesThis = roots.some((r) => containsKind(r, (n) => n.kind === ts.SyntaxKind.ThisKeyword));
  const isAsync = roots.some((r) => containsAwait(r));
  const declaredNames = statements.length ? directlyDeclared(statements) : [];
  const returns = usedAfter(ctx, declaredNames, statements).map((name) => ({
    name,
    declarationKind: declarationKindOf(name, statements),
  }));
  const last = statements[statements.length - 1];
  const endsWithReturn = !!last && ts.isReturnStatement(last);
  const hasConditionalReturn = statements.some(
    (s) => !ts.isReturnStatement(s) && containsKind(s, (n) => ts.isReturnStatement(n)),
  );
  const inClass =
    !!ast.enclosingClassNode &&
    !!ast.enclosingFunctionNode &&
    ast.enclosingFunctionNode.getStart(sf) > ast.enclosingClassNode.getStart(sf);
  const asMethod =
    inClass &&
    (usesThis ||
      ts.isMethodDeclaration(ast.enclosingFunctionNode as ts.Node) ||
      ts.isConstructorDeclaration(ast.enclosingFunctionNode as ts.Node));
  let suggestedName = statements.length
    ? deriveFunctionName(statements, sf)
    : 'get' + capitalize(deriveNameFromExpression(expression as ts.Expression, sf));
  if (returns.length === 1 && !endsWithReturn) {
    suggestedName = (isAsync ? 'fetch' : 'get') + capitalize(returns[0].name);
  }
  return {
    kind: statements.length ? 'statements' : 'expression',
    params,
    returns,
    isAsync,
    usesThis,
    endsWithReturn,
    hasConditionalReturn,
    suggestedName,
    asMethod,
  };
}

export interface ExtractFunctionOptions {
  name?: string;
  /** Force method/function placement (defaults to analysis). */
  asMethod?: boolean;
}

export function extractFunction(ctx: CodeContext, options: ExtractFunctionOptions = {}): CommandResult {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const analysis = analyzeExtraction(ctx);
  if (analysis.hasConditionalReturn) {
    throw new CodePilotError(
      'invalidTransformation',
      'The selection contains a return statement inside a nested block, so it cannot be extracted safely. Select a smaller block.',
    );
  }
  if (analysis.usesThis && !ast.enclosingClassNode) {
    throw new CodePilotError(
      'invalidTransformation',
      'The selection uses `this` outside of a class, so it cannot be extracted safely.',
    );
  }
  if (analysis.returns.length > 1 && analysis.endsWithReturn) {
    throw new CodePilotError(
      'invalidTransformation',
      'The selection both returns a value and declares variables used afterwards. Select a smaller block.',
    );
  }
  const asMethod = options.asMethod ?? analysis.asMethod;
  const isTs = ctx.language.isTypeScript;
  const sc = semi(ctx);
  const taken = new Set([...ctx.scope.visibleNames, ...ctx.declarations.topLevelNames]);
  if (asMethod && ctx.scope.enclosingClass) {
    ctx.scope.enclosingClass.methods.forEach((m) => taken.add(m.name));
    ctx.scope.enclosingClass.properties.forEach((p) => taken.add(p.name));
  }
  const name = uniqueName(options.name ?? analysis.suggestedName, taken);

  const paramList = analysis.params.map((p) => (isTs ? `${p.name}: ${p.typeText}` : p.name)).join(', ');
  const argList = analysis.params.map((p) => p.name).join(', ');

  // Body
  const range = ctx.selection.range;
  const statements = ast.selectedStatements;
  const bodyStart = statements.length ? statements[0].getStart(sf) : range.start;
  const bodyEnd = statements.length ? statements[statements.length - 1].getEnd() : range.end;
  const originalIndent = lineIndentAt(ctx.text, bodyStart);
  const rawBody = ctx.text.slice(bodyStart, bodyEnd);
  const bodyText = dedentSubsequentLines(rawBody, originalIndent, '\n');

  let bodyLines: string;
  let returnStatement = '';
  if (analysis.kind === 'expression') {
    bodyLines = `return ${bodyText}${sc}`;
  } else {
    bodyLines = bodyText;
    if (analysis.returns.length === 1) {
      returnStatement = `\nreturn ${analysis.returns[0].name}${sc}`;
    } else if (analysis.returns.length > 1) {
      returnStatement = `\nreturn { ${analysis.returns.map((r) => r.name).join(', ')} }${sc}`;
    }
  }
  const fullBody = indentAllLines(bodyLines + returnStatement, '\t', '\n');
  const asyncPrefix = analysis.isAsync ? 'async ' : '';

  // Call site
  let call = `${asMethod ? 'this.' : ''}${name}(${argList})`;
  if (analysis.isAsync) {
    call = `await ${call}`;
  }
  let callStatement: string;
  if (analysis.kind === 'expression') {
    callStatement = call;
  } else if (analysis.endsWithReturn) {
    callStatement = `return ${call}${sc}`;
  } else if (analysis.returns.length === 1) {
    const r = analysis.returns[0];
    const kind = r.declarationKind === 'var' ? 'let' : r.declarationKind;
    callStatement = `${kind} ${r.name} = ${call}${sc}`;
  } else if (analysis.returns.length > 1) {
    const anyLet = analysis.returns.some((r) => r.declarationKind !== 'const');
    callStatement = `${anyLet ? 'let' : 'const'} { ${analysis.returns.map((r) => r.name).join(', ')} } = ${call}${sc}`;
  } else {
    callStatement = `${call}${sc}`;
  }

  const edits: TextEdit[] = [];
  const replaceRange = analysis.kind === 'expression' ? range : { start: bodyStart, end: bodyEnd };
  edits.push({ range: replaceRange, text: callStatement });

  let declaration: string;
  if (asMethod && ctx.scope.enclosingClass) {
    const vis = isTs ? 'private ' : '';
    const ret = isTs && analysis.isAsync ? '' : '';
    declaration = `${vis}${asyncPrefix}${name}(${paramList})${ret} {\n${fullBody}\n}`;
    const cls = ctx.scope.enclosingClass;
    // Insert right after the enclosing method for locality.
    const enclosingMethodEnd = ctx.scope.enclosingMethod?.range.end ?? ctx.scope.enclosingFunction?.range.end;
    const classIndent = lineIndentAt(ctx.text, cls.range.start);
    const memberIndent = classIndent + ctx.indent.unit;
    if (enclosingMethodEnd !== undefined) {
      edits.push({
        range: { start: enclosingMethodEnd, end: enclosingMethodEnd },
        text: ctx.eol + ctx.eol + renderCode(declaration, ctx, memberIndent, true),
      });
    } else {
      const plan = planClassMemberInsertion(ctx, cls, 'method');
      edits.push({
        range: plan.range,
        text: plan.prefix + renderCode(declaration, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
      });
    }
  } else {
    declaration = `${asyncPrefix}function ${name}(${paramList}) {\n${fullBody}\n}`;
    const firstRoot = statements.length ? statements[0] : (getSelectedExpression(ctx) as ts.Node);
    const topLevel = getTopLevelStatement(firstRoot);
    const enclosingStmt = getEnclosingStatement(firstRoot);
    const selectionIsTopLevel = !!topLevel && !!enclosingStmt && topLevel === enclosingStmt;
    const plan = planTopLevelInsertion(ctx, {
      position: selectionIsTopLevel ? 'before' : 'after',
      anchor: firstRoot.getStart(sf),
    });
    const declarationText =
      plan.prefix + renderCode(declaration, ctx, plan.indent, plan.indentFirstLine) + plan.suffix;
    if (plan.range.start === replaceRange.start) {
      // Declaration goes exactly where the call starts: emit a single edit so the two never overlap.
      edits[0] = { range: replaceRange, text: declarationText + callStatement };
    } else {
      edits.push({ range: plan.range, text: declarationText });
    }
  }

  const what =
    analysis.kind === 'expression'
      ? 'expression'
      : `${statements.length} statement${statements.length === 1 ? '' : 's'}`;
  return {
    edits,
    message: `Extracted ${what} into ${asMethod ? 'method' : 'function'} ${name}(${argList})`,
    format: true,
  };
}
