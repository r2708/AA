/**
 * Wraps selected statements in a block construct (try/catch, if, loops, ...)
 * while preserving their indentation.
 */
import type { CodeContext } from '../types/context';
import { CodePilotError, type CommandResult } from '../types/command';
import { tsOf, lineIndentAt } from '../languages/typescript/tsContext';
import { escapeSnippet, indentSubsequentLines, renderCode } from '../generators/codeWriter';

export interface WrapTemplate {
  /** Snippet template placed before the statements; must end with `\n\t` for one nesting level. */
  before: string;
  /** Snippet template placed after the statements; must start with `\n`. */
  after: string;
}

/** Statement range covered by the selection (throws when it is not whole statements). */
export function requireSelectedStatements(ctx: CodeContext) {
  const ast = tsOf(ctx);
  if (ast.selectedStatements.length === 0) {
    throw new CodePilotError('invalidSelection', 'Select one or more complete statements to wrap.');
  }
  const sf = ast.sourceFile;
  const first = ast.selectedStatements[0];
  const last = ast.selectedStatements[ast.selectedStatements.length - 1];
  return { statements: ast.selectedStatements, start: first.getStart(sf), end: last.getEnd() };
}

/**
 * Produces a snippet that replaces the selected statements with
 * `before + <statements indented one level> + after`.
 */
export function wrapStatements(
  ctx: CodeContext,
  template: WrapTemplate,
  extra: Partial<CommandResult> = {},
): CommandResult {
  const { start, end } = requireSelectedStatements(ctx);
  const baseIndent = lineIndentAt(ctx.text, start);
  const original = ctx.text.slice(start, end);
  const inner = indentSubsequentLines(escapeSnippet(original), ctx.indent.unit, ctx.eol);
  const body =
    renderCode(template.before, ctx, baseIndent) + inner + renderCode(template.after, ctx, baseIndent);
  return { snippet: { range: { start, end }, body }, ...extra };
}

/** Wraps the innermost statement containing the cursor (when nothing is selected). */
export function wrapCursorStatement(
  ctx: CodeContext,
  template: WrapTemplate,
  extra: Partial<CommandResult> = {},
): CommandResult {
  const ast = tsOf(ctx);
  const stmt = ast.enclosingStatementNode;
  if (!stmt) {
    throw new CodePilotError(
      'invalidSelection',
      'Place the cursor on a statement or select the statements to wrap.',
    );
  }
  const sf = ast.sourceFile;
  const start = stmt.getStart(sf);
  const end = stmt.getEnd();
  const baseIndent = lineIndentAt(ctx.text, start);
  const inner = indentSubsequentLines(escapeSnippet(ctx.text.slice(start, end)), ctx.indent.unit, ctx.eol);
  const body =
    renderCode(template.before, ctx, baseIndent) + inner + renderCode(template.after, ctx, baseIndent);
  return { snippet: { range: { start, end }, body }, ...extra };
}
