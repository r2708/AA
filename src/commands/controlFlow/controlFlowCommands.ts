/**
 * Control-flow commands (Ctrl+Shift+F1 ... Ctrl+Shift+F12).
 */
import * as ts from 'typescript';
import type { CodeContext, VariableInfo } from '../../types/context';
import { CodePilotError, type CommandDefinition, type CommandResult } from '../../types/command';
import { defineCommand } from '../commandRegistry';
import {
  JS_LANGUAGES,
  canInsertStatement,
  describeSelection,
  insertStatementSnippet,
  no,
  ok,
  statementScopeReason,
} from '../helpers';
import {
  getSelectedExpression,
  lineIndentAt,
  tsOf,
  unwrapExpression,
} from '../../languages/typescript/tsContext';
import { containsAwait } from '../../analyzer/astAnalyzer';
import { checkerTypeText } from '../../analyzer/typeInference';
import { singularize, uniqueName } from '../../analyzer/naming';
import { wrapCursorStatement, wrapStatements } from '../../transformations/wrap';
import { ifElseToTernary } from '../../transformations/convert';
import { escapeSnippet, renderCode, semi } from '../../generators/codeWriter';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A selected expression that can be used as a condition/target (whole statement or bare identifier). */
function selectedTargetExpression(
  ctx: CodeContext,
): { expr: ts.Expression; wholeStatement: ts.ExpressionStatement | undefined } | undefined {
  if (ctx.selection.kind === 'none') {
    return undefined;
  }
  const expr = getSelectedExpression(ctx);
  if (!expr) {
    return undefined;
  }
  const stmt =
    expr.parent && ts.isExpressionStatement(expr.parent) && expr.parent.expression === expr
      ? expr.parent
      : undefined;
  if (stmt && ctx.selection.kind === 'statements') {
    // A selected `foo();` statement is code to wrap, not a value; a bare `items;` / `a.b;` is a target.
    const e = unwrapExpression(expr);
    const isValueLike =
      ts.isIdentifier(e) ||
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e) ||
      (ts.isBinaryExpression(e) && !/=$/.test(e.operatorToken.getText())) ||
      ts.isPrefixUnaryExpression(e);
    if (!isValueLike) {
      return undefined;
    }
  }
  return { expr, wholeStatement: stmt };
}

function isWrapSelection(ctx: CodeContext): boolean {
  return (
    (ctx.selection.kind === 'statements' || ctx.selection.kind === 'declaration') &&
    !selectedTargetExpression(ctx)
  );
}

function nearestVariable(ctx: CodeContext, predicate: (v: VariableInfo) => boolean): string | undefined {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const candidates: { name: string; pos: number }[] = [];
  // Locals of the enclosing function declared before the cursor.
  const fn = ast.enclosingFunctionNode;
  if (fn) {
    for (const p of fn.parameters) {
      if (
        ts.isIdentifier(p.name) &&
        p.type &&
        /\[\]$|^Array<|^ReadonlyArray</.test(p.type.getText(sf)) &&
        predicate({
          name: p.name.text,
          kind: 'variable',
          range: { start: 0, end: 0 },
          isExported: false,
          declarationKind: 'const',
          typeText: p.type.getText(sf),
          isTopLevel: false,
        })
      ) {
        candidates.push({ name: p.name.text, pos: p.getStart(sf) });
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isVariableStatement(node) && node.getEnd() <= ctx.cursor) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            const info: VariableInfo = {
              name: d.name.text,
              kind: 'variable',
              range: { start: node.getStart(sf), end: node.getEnd() },
              isExported: false,
              declarationKind: 'const',
              typeText: d.type?.getText(sf),
              initializerText: d.initializer?.getText(sf),
              initializerKind:
                d.initializer && ts.isArrayLiteralExpression(d.initializer)
                  ? 'array'
                  : d.initializer && ts.isObjectLiteralExpression(d.initializer)
                    ? 'object'
                    : 'other',
              isTopLevel: false,
            };
            if (predicate(info)) {
              candidates.push({ name: info.name, pos: node.getStart(sf) });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) {
      visit(fn.body);
    }
  }
  for (const v of ctx.declarations.variables) {
    if (v.range.end <= ctx.cursor && predicate(v)) {
      candidates.push({ name: v.name, pos: v.range.start });
    }
  }
  candidates.sort((a, b) => b.pos - a.pos);
  return candidates[0]?.name;
}

const isArrayLike = (v: VariableInfo): boolean =>
  v.initializerKind === 'array' ||
  /\[\]$|^Array<|^ReadonlyArray</.test(v.typeText ?? '') ||
  /\.(map|filter|split|slice|concat)\(/.test(v.initializerText ?? '') ||
  /^\[/.test(v.initializerText ?? '');
const isObjectLike = (v: VariableInfo): boolean =>
  v.initializerKind === 'object' || /^Record<|^\{/.test(v.typeText ?? '');

function loopSnippetForExpression(ctx: CodeContext, kind: 'of' | 'in' | 'index', exprText: string): string {
  const base =
    exprText
      .replace(/^this\./, '')
      .split(/[.[(]/)
      .pop() || 'item';
  const sc = semi(ctx);
  if (kind === 'of') {
    const item = uniqueName(singularize(base) === base ? 'item' : singularize(base), ctx.scope.visibleNames);
    return `for (const \${1:${item}} of ${escapeSnippet(exprText)}) {\n\t$0\n}`;
  }
  if (kind === 'in') {
    return `for (const \${1:key} in ${escapeSnippet(exprText)}) {\n\tif (Object.hasOwn(${escapeSnippet(exprText)}, \${1})) {\n\t\t$0\n\t}\n}`;
  }
  const i = uniqueName('i', ctx.scope.visibleNames);
  return `for (let \${1:${i}} = 0; \${1} < ${escapeSnippet(exprText)}.length; \${1}++) {\n\t$0\n}${sc === ';' ? '' : ''}`;
}

/** Applies a loop/if around a selected target expression or inserts it at the statement position. */
function statementFromExpression(ctx: CodeContext, template: string): CommandResult {
  const target = selectedTargetExpression(ctx);
  const ast = tsOf(ctx);
  if (target?.wholeStatement) {
    const stmt = target.wholeStatement;
    const start = stmt.getStart(ast.sourceFile);
    const baseIndent = lineIndentAt(ctx.text, start);
    return { snippet: { range: { start, end: stmt.getEnd() }, body: renderCode(template, ctx, baseIndent) } };
  }
  return insertStatementSnippet(ctx, template);
}

function wrapOrInsert(
  ctx: CodeContext,
  before: string,
  after: string,
  skeleton: string,
  message?: string,
): CommandResult {
  if (isWrapSelection(ctx)) {
    return wrapStatements(ctx, { before, after }, { message });
  }
  return insertStatementSnippet(ctx, skeleton);
}

function controlFlowApplicability(
  ctx: CodeContext,
  wrapDetail: string,
  insertDetail: string,
  wrapScore = 55,
  insertScore = 20,
) {
  if (isWrapSelection(ctx)) {
    return ok(wrapScore, `${wrapDetail} ${describeSelection(ctx)}`);
  }
  if (ctx.selection.kind !== 'none') {
    const target = selectedTargetExpression(ctx);
    if (target) {
      return ok(wrapScore - 5, `${insertDetail} using ${describeSelection(ctx)}`);
    }
    return no('Select complete statements to wrap, or clear the selection.');
  }
  if (!canInsertStatement(ctx)) {
    return no(statementScopeReason(ctx));
  }
  return ok(insertScore, insertDetail);
}

// ---------------------------------------------------------------------------
// Ctrl+Shift+F1 If / Else
// ---------------------------------------------------------------------------

export const createIfElse: CommandDefinition = defineCommand({
  id: 'codepilot.createIfElse',
  title: 'Create If / Else',
  category: 'controlFlow',
  description:
    'Wraps the selected statements in an if block, uses a selected expression as the condition, or inserts an if/else skeleton.',
  keybinding: { key: 'ctrl+shift+f1' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => controlFlowApplicability(ctx, 'Wrap', 'Insert an if / else block'),
  async execute(ctx) {
    const target = selectedTargetExpression(ctx);
    if (target) {
      const cond = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
      if (target.wholeStatement) {
        return statementFromExpression(ctx, `if (${escapeSnippet(cond)}) {\n\t$0\n}`);
      }
      // Sub-expression: turn it into a condition in place.
      return {
        snippet: {
          range: ctx.selection.range,
          body: `${escapeSnippet(cond)} ? \${1:whenTrue} : \${2:whenFalse}`,
        },
      };
    }
    return wrapOrInsert(
      ctx,
      'if (${1:condition}) {\n\t',
      '\n}',
      'if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}',
      'Wrapped the selection in an if block',
    );
  },
});

// ---------------------------------------------------------------------------
// Ctrl+Shift+F2 Switch
// ---------------------------------------------------------------------------

function switchCasesFor(
  ctx: CodeContext,
  expr: ts.Expression,
): { cases: string[]; source: string } | undefined {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const q = ctx.style.quote;
  // Declared type annotation of the identifier.
  let typeName: string | undefined;
  const e = unwrapExpression(expr);
  if (ts.isIdentifier(e)) {
    const fn = ast.enclosingFunctionNode;
    const param = fn?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === e.text);
    if (param?.type) {
      typeName = param.type.getText(sf);
    } else {
      const variable = ctx.declarations.variables.find((v) => v.name === e.text);
      typeName = variable?.typeText;
    }
  } else if (ts.isPropertyAccessExpression(e)) {
    const owner = e.expression;
    const ownerName = ts.isIdentifier(owner) ? owner.text : undefined;
    const fn = ast.enclosingFunctionNode;
    const param = fn?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === ownerName);
    const ownerType =
      param?.type?.getText(sf) ?? ctx.declarations.variables.find((v) => v.name === ownerName)?.typeText;
    const iface =
      ctx.declarations.interfaces.find((i) => i.name === ownerType) ??
      ctx.declarations.types.find((t) => t.name === ownerType);
    const member =
      iface && 'members' in iface ? iface.members?.find((m) => m.name === e.name.text) : undefined;
    typeName = member?.typeText;
  }
  if (typeName) {
    const en = ctx.declarations.enums.find((x) => x.name === typeName);
    if (en) {
      return { cases: en.members.map((m) => `${en.name}.${m.name}`), source: `enum ${en.name}` };
    }
    const alias = ctx.declarations.types.find((t) => t.name === typeName);
    if (alias?.unionLiterals) {
      return {
        cases: alias.unionLiterals.map((v) => (/^\d/.test(v) ? v : `${q}${v}${q}`)),
        source: `type ${alias.name}`,
      };
    }
    const inline = typeName.split('|').map((s) => s.trim());
    if (inline.length > 1 && inline.every((s) => /^['"`].*['"`]$/.test(s) || /^\d+$/.test(s))) {
      return {
        cases: inline.map((s) => (/^\d/.test(s) ? s : `${q}${s.slice(1, -1)}${q}`)),
        source: 'the union type',
      };
    }
  }
  const fromChecker = checkerTypeText(ast.getChecker(), e);
  if (fromChecker) {
    const parts = fromChecker.split('|').map((s) => s.trim());
    if (parts.length > 1 && parts.every((s) => /^["'`].*["'`]$/.test(s) || /^\d+$/.test(s))) {
      return {
        cases: parts.map((s) => (/^\d/.test(s) ? s : `${q}${s.slice(1, -1)}${q}`)),
        source: 'the inferred union type',
      };
    }
    const en = ctx.declarations.enums.find((x) => x.name === fromChecker);
    if (en) {
      return { cases: en.members.map((m) => `${en.name}.${m.name}`), source: `enum ${en.name}` };
    }
  }
  return undefined;
}

export const createSwitch: CommandDefinition = defineCommand({
  id: 'codepilot.createSwitch',
  title: 'Create Switch',
  category: 'controlFlow',
  description:
    'Creates a switch on the selected expression, generating a case for every enum member or union literal when the type is known.',
  keybinding: { key: 'ctrl+shift+f2' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const target = selectedTargetExpression(ctx);
    if (target) {
      const cases = switchCasesFor(ctx, target.expr);
      return ok(
        cases ? 80 : 50,
        cases
          ? `Switch on ${describeSelection(ctx)} with ${cases.cases.length} cases from ${cases.source}`
          : `Switch on ${describeSelection(ctx)}`,
      );
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select the expression to switch on.');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(15, 'Insert a switch skeleton');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const target = selectedTargetExpression(ctx);
    if (target) {
      const exprText = escapeSnippet(ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end));
      const cases = switchCasesFor(ctx, target.expr);
      let body: string;
      if (cases) {
        let p = 1;
        body =
          cases.cases.map((c) => `\tcase ${escapeSnippet(c)}:\n\t\t\${${p++}}\n\t\tbreak${sc}`).join('\n') +
          `\n\tdefault:\n\t\t$0\n\t\tbreak${sc}`;
      } else {
        body = `\tcase \${1:value}:\n\t\t$0\n\t\tbreak${sc}\n\tdefault:\n\t\tbreak${sc}`;
      }
      const template = `switch (${exprText}) {\n${body}\n}`;
      if (target.wholeStatement) {
        return statementFromExpression(ctx, template);
      }
      const result = insertStatementSnippet(ctx, template);
      return {
        ...result,
        message: cases ? `Generated ${cases.cases.length} cases from ${cases.source}` : undefined,
      };
    }
    return insertStatementSnippet(
      ctx,
      `switch (\${1:value}) {\n\tcase \${2:value}:\n\t\t$0\n\t\tbreak${sc}\n\tdefault:\n\t\tbreak${sc}\n}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Ctrl+Shift+F3..F5 loops
// ---------------------------------------------------------------------------

function loopCommand(
  id: string,
  title: string,
  key: string,
  kind: 'index' | 'of' | 'in',
  description: string,
): CommandDefinition {
  const predicate = kind === 'in' ? isObjectLike : isArrayLike;
  return defineCommand({
    id,
    title,
    category: 'controlFlow',
    description,
    keybinding: { key },
    supportedLanguages: JS_LANGUAGES,
    canExecute(ctx) {
      if (isWrapSelection(ctx)) {
        return ok(45, `Wrap ${describeSelection(ctx)} in a loop`);
      }
      const target = selectedTargetExpression(ctx);
      if (target) {
        return ok(65, `Loop over ${describeSelection(ctx)}`);
      }
      if (ctx.selection.kind !== 'none') {
        return no('Select the collection to iterate or complete statements to wrap.');
      }
      if (!canInsertStatement(ctx)) {
        return no(statementScopeReason(ctx));
      }
      const nearest = nearestVariable(ctx, predicate);
      return ok(nearest ? 35 : 15, nearest ? `Loop over ${nearest}` : 'Insert a loop');
    },
    async execute(ctx) {
      if (isWrapSelection(ctx)) {
        const collection = nearestVariable(ctx, predicate) ?? (kind === 'in' ? 'object' : 'items');
        const header =
          kind === 'of'
            ? `for (const \${1:${singularize(collection) === collection ? 'item' : singularize(collection)}} of \${2:${collection}}) {\n\t`
            : kind === 'in'
              ? `for (const \${1:key} in \${2:${collection}}) {\n\t`
              : `for (let \${1:i} = 0; \${1} < \${2:${collection}}.length; \${1}++) {\n\t`;
        return wrapStatements(ctx, { before: header, after: '\n}' });
      }
      const target = selectedTargetExpression(ctx);
      if (target) {
        const text = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
        return statementFromExpression(ctx, loopSnippetForExpression(ctx, kind, text));
      }
      const nearest = nearestVariable(ctx, predicate);
      if (nearest) {
        return insertStatementSnippet(ctx, loopSnippetForExpression(ctx, kind, nearest));
      }
      const skeleton =
        kind === 'of'
          ? `for (const \${1:item} of \${2:items}) {\n\t$0\n}`
          : kind === 'in'
            ? `for (const \${1:key} in \${2:object}) {\n\t$0\n}`
            : `for (let \${1:i} = 0; \${1} < \${2:items}.length; \${1}++) {\n\t$0\n}`;
      return insertStatementSnippet(ctx, skeleton);
    },
  });
}

export const createForLoop = loopCommand(
  'codepilot.createForLoop',
  'Create For Loop',
  'ctrl+shift+f3',
  'index',
  'Inserts an index-based for loop over the selected or nearest array.',
);
export const createForOf = loopCommand(
  'codepilot.createForOf',
  'Create For...Of',
  'ctrl+shift+f4',
  'of',
  'Inserts a for...of loop over the selected or nearest array with a singularised item name.',
);
export const createForIn = loopCommand(
  'codepilot.createForIn',
  'Create For...In',
  'ctrl+shift+f5',
  'in',
  'Inserts a for...in loop over the selected or nearest object with an own-property guard.',
);

// ---------------------------------------------------------------------------
// Ctrl+Shift+F6 / F7 while, do...while
// ---------------------------------------------------------------------------

export const createWhile: CommandDefinition = defineCommand({
  id: 'codepilot.createWhile',
  title: 'Create While Loop',
  category: 'controlFlow',
  description: 'Wraps the selection in a while loop or inserts one.',
  keybinding: { key: 'ctrl+shift+f6' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => controlFlowApplicability(ctx, 'Wrap', 'Insert a while loop', 40, 10),
  async execute(ctx) {
    const target = selectedTargetExpression(ctx);
    if (target) {
      const cond = escapeSnippet(ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end));
      return statementFromExpression(ctx, `while (${cond}) {\n\t$0\n}`);
    }
    return wrapOrInsert(ctx, 'while (${1:condition}) {\n\t', '\n}', 'while (${1:condition}) {\n\t$0\n}');
  },
});

export const createDoWhile: CommandDefinition = defineCommand({
  id: 'codepilot.createDoWhile',
  title: 'Create Do...While',
  category: 'controlFlow',
  description: 'Wraps the selection in a do...while loop or inserts one.',
  keybinding: { key: 'ctrl+shift+f7' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => controlFlowApplicability(ctx, 'Wrap', 'Insert a do...while loop', 35, 10),
  async execute(ctx) {
    const sc = semi(ctx);
    return wrapOrInsert(
      ctx,
      'do {\n\t',
      `\n} while (\${1:condition})${sc}`,
      `do {\n\t$0\n} while (\${1:condition})${sc}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Ctrl+Shift+F8 / F9 try/catch(/finally)
// ---------------------------------------------------------------------------

function catchVariable(ctx: CodeContext): string {
  return uniqueName('error', ctx.scope.visibleNames);
}

function cursorStatementIsRisky(ctx: CodeContext): boolean {
  const stmt = tsOf(ctx).enclosingStatementNode;
  if (!stmt || ts.isTryStatement(stmt) || ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    return false;
  }
  if (containsAwait(stmt)) {
    return true;
  }
  return /\bJSON\.parse\(|\bnew URL\(|\.json\(\)|\bthrow\b/.test(stmt.getText());
}

function tryCatchCommand(id: string, title: string, key: string, withFinally: boolean): CommandDefinition {
  return defineCommand({
    id,
    title,
    category: 'controlFlow',
    description: withFinally
      ? 'Wraps the selection (or the awaited statement at the cursor) in try / catch / finally.'
      : 'Wraps the selection (or the awaited statement at the cursor) in try / catch.',
    keybinding: { key },
    supportedLanguages: JS_LANGUAGES,
    canExecute(ctx) {
      if (isWrapSelection(ctx)) {
        const risky = tsOf(ctx).selectedStatements.some((s) => containsAwait(s));
        return ok(
          risky ? 80 : 50,
          `Wrap ${describeSelection(ctx)} in try/catch${withFinally ? '/finally' : ''}`,
        );
      }
      if (ctx.selection.kind !== 'none') {
        return no('Select complete statements to wrap in try/catch.');
      }
      if (cursorStatementIsRisky(ctx)) {
        return ok(60, `Wrap the current statement in try/catch${withFinally ? '/finally' : ''}`);
      }
      if (!canInsertStatement(ctx)) {
        return no(statementScopeReason(ctx));
      }
      return ok(15, `Insert a try/catch${withFinally ? '/finally' : ''} block`);
    },
    async execute(ctx) {
      const err = catchVariable(ctx);
      const after = withFinally
        ? `\n} catch (${err}) {\n\t\${1:console.error(${err})${semi(ctx)}}\n} finally {\n\t\${2}\n}`
        : `\n} catch (${err}) {\n\t\${1:console.error(${err})${semi(ctx)}}\n}`;
      if (isWrapSelection(ctx)) {
        return wrapStatements(ctx, { before: 'try {\n\t', after });
      }
      if (ctx.selection.kind === 'none' && cursorStatementIsRisky(ctx)) {
        return wrapCursorStatement(ctx, { before: 'try {\n\t', after });
      }
      const skeleton = withFinally
        ? `try {\n\t$0\n} catch (${err}) {\n\t\${1:console.error(${err})${semi(ctx)}}\n} finally {\n\t\${2}\n}`
        : `try {\n\t$0\n} catch (${err}) {\n\t\${1:console.error(${err})${semi(ctx)}}\n}`;
      return insertStatementSnippet(ctx, skeleton);
    },
  });
}

export const createTryCatch = tryCatchCommand(
  'codepilot.createTryCatch',
  'Create Try / Catch',
  'ctrl+shift+f8',
  false,
);
export const createTryCatchFinally = tryCatchCommand(
  'codepilot.createTryCatchFinally',
  'Create Try / Catch / Finally',
  'ctrl+shift+f9',
  true,
);

// ---------------------------------------------------------------------------
// Ctrl+Shift+F10 Throw Error
// ---------------------------------------------------------------------------

export const createThrowError: CommandDefinition = defineCommand({
  id: 'codepilot.createThrowError',
  title: 'Create Throw Error',
  category: 'controlFlow',
  description:
    'Inserts a throw statement, offering custom Error subclasses declared in the file and re-throwing with `cause` inside catch blocks.',
  keybinding: { key: 'ctrl+shift+f10' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (ctx.selection.kind !== 'none') {
      const expr = getSelectedExpression(ctx);
      if (
        expr &&
        (ts.isStringLiteral(unwrapExpression(expr)) ||
          ts.isTemplateExpression(unwrapExpression(expr)) ||
          ts.isNoSubstitutionTemplateLiteral(unwrapExpression(expr)))
      ) {
        return ok(50, `Throw an Error with ${describeSelection(ctx)} as message`);
      }
      return no('Select a message string or clear the selection.');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(
      ctx.scope.inCatchClause ? 40 : 15,
      ctx.scope.inCatchClause ? 'Re-throw the caught error' : 'Insert a throw statement',
    );
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const q = ctx.style.quote;
    const customErrors = ctx.declarations.classes
      .filter((c) => /Error$/.test(c.extendsName ?? '') || /Error$/.test(c.name))
      .map((c) => c.name);
    const choices = [...customErrors, 'Error', 'TypeError', 'RangeError'].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    const errorType = choices.length > 1 ? `\${1|${choices.join(',')}|}` : 'Error';
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const messageText = escapeSnippet(ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end));
      const stmt = expr.parent && ts.isExpressionStatement(expr.parent) ? expr.parent : undefined;
      const template = `throw new ${errorType}(${messageText})${sc}`;
      if (stmt) {
        return statementFromExpression(ctx, template);
      }
      return { snippet: { range: ctx.selection.range, body: `new ${errorType}(${messageText})` } };
    }
    if (ctx.scope.inCatchClause && ctx.scope.catchVariableName) {
      const v = ctx.scope.catchVariableName;
      return insertStatementSnippet(
        ctx,
        `throw \${1|${v},new Error(${q}message${q}\\, { cause: ${v} })|}${sc}`,
      );
    }
    return insertStatementSnippet(ctx, `throw new ${errorType}(${q}\${2:message}${q})${sc}`);
  },
});

// ---------------------------------------------------------------------------
// Ctrl+Shift+F11 Return
// ---------------------------------------------------------------------------

export const createReturn: CommandDefinition = defineCommand({
  id: 'codepilot.createReturn',
  title: 'Create Return',
  category: 'controlFlow',
  description:
    'Inserts a return statement matching the enclosing function (JSX for components, the selected expression as value).',
  keybinding: { key: 'ctrl+shift+f11' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (!ctx.scope.enclosingFunction) {
      return no('Place the cursor inside a function to insert a return statement.');
    }
    if (ctx.scope.enclosingFunction.hasExpressionBody && ctx.selection.kind === 'none') {
      return no('The enclosing arrow function already returns its expression body.');
    }
    if (ctx.selection.kind !== 'none') {
      const expr = getSelectedExpression(ctx);
      if (expr) {
        return ok(55, `Return ${describeSelection(ctx)}`);
      }
      return no('Select an expression to return, or clear the selection.');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(20, ctx.react.enclosingComponent ? 'Insert a JSX return' : 'Insert a return statement');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const text = escapeSnippet(ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end));
      const stmt = expr.parent && ts.isExpressionStatement(expr.parent) ? expr.parent : undefined;
      if (stmt) {
        return statementFromExpression(ctx, `return ${text}${sc}`);
      }
      return { snippet: { range: ctx.selection.range, body: `return ${text}` } };
    }
    if (ctx.react.enclosingComponent && ctx.language.isJsx) {
      return insertStatementSnippet(ctx, `return (\n\t<\${1:div}>\n\t\t$0\n\t</\${1}>\n)${sc}`);
    }
    const ret = ctx.scope.enclosingFunction?.returnTypeText;
    const hint = ret ? ret.replace(/^Promise<(.*)>$/, '$1') : undefined;
    if (hint === 'void') {
      return insertStatementSnippet(ctx, `return${sc}`);
    }
    return insertStatementSnippet(
      ctx,
      `return \${1:${escapeSnippet(hint ? `undefined as unknown as ${hint}` : 'value').replace(/^undefined as unknown as /, '')}}${sc}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Ctrl+Shift+F12 Ternary
// ---------------------------------------------------------------------------

export const createTernary: CommandDefinition = defineCommand({
  id: 'codepilot.createTernary',
  title: 'Create Ternary',
  category: 'controlFlow',
  description:
    'Converts a selected if/else with matching returns or assignments into a ternary, or inserts a conditional expression.',
  keybinding: { key: 'ctrl+shift+f12' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const ast = tsOf(ctx);
    if (ast.selectedStatements.length === 1 && ts.isIfStatement(ast.selectedStatements[0])) {
      const converted = ifElseToTernary(ctx, ast.selectedStatements[0]);
      return converted
        ? ok(85, 'Convert the if/else into a ternary')
        : no('Only if/else blocks with a single return or assignment in each branch can become a ternary.');
    }
    if (ctx.selection.kind !== 'none') {
      const expr = getSelectedExpression(ctx);
      if (expr) {
        return ok(40, `Use ${describeSelection(ctx)} as the ternary condition`);
      }
      return no('Select an if/else statement or a condition expression.');
    }
    if (ctx.scope.kind === 'class' || ctx.scope.kind === 'interface') {
      return no(statementScopeReason(ctx));
    }
    return ok(10, 'Insert a ternary expression');
  },
  async execute(ctx) {
    const ast = tsOf(ctx);
    if (ast.selectedStatements.length === 1 && ts.isIfStatement(ast.selectedStatements[0])) {
      const stmt = ast.selectedStatements[0];
      const converted = ifElseToTernary(ctx, stmt);
      if (!converted) {
        throw new CodePilotError(
          'invalidTransformation',
          'Only if/else blocks with a single return or assignment in each branch can become a ternary.',
        );
      }
      return {
        edits: [{ range: { start: stmt.getStart(ast.sourceFile), end: stmt.getEnd() }, text: converted }],
        message: 'Converted if/else into a ternary',
      };
    }
    if (ctx.selection.kind !== 'none') {
      const text = escapeSnippet(ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end));
      return { snippet: { range: ctx.selection.range, body: `${text} ? \${1:whenTrue} : \${2:whenFalse}` } };
    }
    return {
      snippet: {
        range: { start: ctx.cursor, end: ctx.cursor },
        body: `\${1:condition} ? \${2:whenTrue} : \${3:whenFalse}`,
      },
    };
  },
});

export const controlFlowCommands: CommandDefinition[] = [
  createIfElse,
  createSwitch,
  createForLoop,
  createForOf,
  createForIn,
  createWhile,
  createDoWhile,
  createTryCatch,
  createTryCatchFinally,
  createThrowError,
  createReturn,
  createTernary,
];
