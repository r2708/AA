/**
 * Shared building blocks for command implementations.
 */
import type { CodeContext, Range } from '../types/context';
import type { Applicability, CommandResult, TextEdit } from '../types/command';
import { CodePilotError } from '../types/command';
import { SUPPORTED_LANGUAGE_IDS } from '../analyzer/languageDetector';
import { escapeSnippet, renderCode } from '../generators/codeWriter';
import {
  planStatementInsertion,
  planTopLevelInsertion,
  type InsertionPlan,
  type TopLevelOptions,
} from '../transformations/insertion';

export const JS_LANGUAGES: string[] = [...SUPPORTED_LANGUAGE_IDS];

export function ok(score: number, detail?: string): Applicability {
  return { available: true, score, detail };
}

export function no(reason: string): Applicability {
  return { available: false, reason };
}

export function fail(kind: CodePilotError['kind'], message: string): never {
  throw new CodePilotError(kind, message);
}

/** Renders a snippet template (`\t`/`\n` based, placeholders allowed) at a plan. */
export function snippetAtPlan(
  ctx: CodeContext,
  plan: InsertionPlan,
  template: string,
  extra: Partial<CommandResult> = {},
): CommandResult {
  const body =
    escapeSnippet(plan.prefix) +
    renderCode(template, ctx, plan.indent, plan.indentFirstLine) +
    escapeSnippet(plan.suffix);
  return { snippet: { range: plan.range, body }, ...extra };
}

/** Plain-text insertion at a plan. */
export function editAtPlan(ctx: CodeContext, plan: InsertionPlan, code: string): TextEdit {
  return {
    range: plan.range,
    text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
  };
}

export function insertStatementSnippet(
  ctx: CodeContext,
  template: string,
  extra: Partial<CommandResult> = {},
): CommandResult {
  return snippetAtPlan(ctx, planStatementInsertion(ctx), template, extra);
}

export function insertTopLevelSnippet(
  ctx: CodeContext,
  template: string,
  options: TopLevelOptions = {},
  extra: Partial<CommandResult> = {},
): CommandResult {
  return snippetAtPlan(ctx, planTopLevelInsertion(ctx, options), template, extra);
}

/** Replaces the (trimmed) selection with a snippet whose body is already rendered. */
export function replaceSelectionSnippet(
  ctx: CodeContext,
  body: string,
  extra: Partial<CommandResult> = {},
): CommandResult {
  return { snippet: { range: ctx.selection.range, body }, ...extra };
}

export function replaceRange(range: Range, text: string): TextEdit {
  return { range, text };
}

/** True when the cursor is in a place where a statement can be inserted. */
export function canInsertStatement(ctx: CodeContext): boolean {
  const k = ctx.scope.kind;
  return k === 'module' || k === 'function' || k === 'method' || k === 'block';
}

export function statementScopeReason(ctx: CodeContext): string {
  switch (ctx.scope.kind) {
    case 'class':
      return 'The cursor is directly inside a class body. Move it into a method or use Create Method / Create Property.';
    case 'object':
      return 'The cursor is inside an object literal. Move it to a statement position.';
    case 'interface':
      return 'The cursor is inside an interface. Move it to a statement position.';
    case 'jsx':
      return 'The cursor is inside JSX. Move it to a statement position.';
    default:
      return 'Statements cannot be inserted at the cursor position.';
  }
}

/** Human readable label for a selection used in Smart Action descriptions. */
export function describeSelection(ctx: CodeContext): string {
  const s = ctx.selection;
  if (s.kind === 'statements') {
    return `${s.statementCount} statement${s.statementCount === 1 ? '' : 's'}`;
  }
  if (s.kind === 'expression' || s.kind === 'identifier') {
    const text = s.text.length > 30 ? `${s.text.slice(0, 27)}...` : s.text;
    return `\`${text.replace(/\s+/g, ' ')}\``;
  }
  return 'the selection';
}
