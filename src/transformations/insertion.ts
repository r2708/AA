/**
 * Decides WHERE generated code goes and with which indentation, so that
 * generators never corrupt surrounding code.
 */
import * as ts from 'typescript';
import type { ClassInfo, CodeContext, Range } from '../types/context';
import { lineIndentAt, lineStartOf, tsOf } from '../languages/typescript/tsContext';
import type { TextEdit } from '../types/command';
import { renderCode } from '../generators/codeWriter';

export interface InsertionPlan {
  /** Range replaced by the insertion (empty range = pure insertion). */
  range: Range;
  /** Indentation applied to every generated line (the first line is placed after `prefix`). */
  indent: string;
  /** Text emitted before the generated code (line breaks + indentation). */
  prefix: string;
  /** Text emitted after the generated code. */
  suffix: string;
  /** True when the plan replaces a blank line: the first generated line needs the indent too. */
  indentFirstLine?: boolean;
}

function statementContainerOf(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

function statementsOfContainer(container: ts.Node): readonly ts.Statement[] {
  if (
    ts.isBlock(container) ||
    ts.isSourceFile(container) ||
    ts.isModuleBlock(container) ||
    ts.isCaseClause(container) ||
    ts.isDefaultClause(container)
  ) {
    return container.statements;
  }
  return [];
}

function restOfLineIsBlank(text: string, offset: number): boolean {
  const nl = text.indexOf('\n', offset);
  const rest = nl === -1 ? text.slice(offset) : text.slice(offset, nl);
  return rest.trim().length === 0;
}

function startOfLineIsBlank(text: string, offset: number): boolean {
  const start = lineStartOf(text, offset);
  return text.slice(start, offset).trim().length === 0;
}

/**
 * Plans the insertion of one or more statements at the cursor:
 *  - a blank cursor line is reused;
 *  - otherwise the code goes after the statement containing the cursor;
 *  - when the cursor sits at the start of a statement the code goes before it.
 */
export function planStatementInsertion(ctx: CodeContext): InsertionPlan {
  const ast = tsOf(ctx);
  const text = ctx.text;
  const cursor = ctx.cursor;
  const line = ctx.currentLine;
  if (line.isBlank) {
    return {
      range: { start: line.start, end: line.end },
      indent: ctx.scope.statementIndent,
      prefix: '',
      suffix: '',
      indentFirstLine: true,
    };
  }
  const container = statementContainerOf(ast.nodeAtCursor);
  const statements = statementsOfContainer(container);
  const stmt = statements.find((s) => s.getStart(ast.sourceFile) <= cursor && cursor <= s.getEnd());
  if (stmt) {
    const stmtStart = stmt.getStart(ast.sourceFile);
    const indent = lineIndentAt(text, stmtStart);
    if (cursor === stmtStart) {
      return { range: { start: stmtStart, end: stmtStart }, indent, prefix: '', suffix: ctx.eol + indent };
    }
    return {
      range: { start: stmt.getEnd(), end: stmt.getEnd() },
      indent,
      prefix: ctx.eol + indent,
      suffix: '',
    };
  }
  // Cursor is in the container but not inside a statement (e.g. right after `{`).
  const indent = ctx.scope.statementIndent;
  const prefix = startOfLineIsBlank(text, cursor) ? '' : ctx.eol + indent;
  const containerIndent = ts.isSourceFile(container)
    ? ''
    : lineIndentAt(text, container.getStart(ast.sourceFile));
  const suffix = restOfLineIsBlank(text, cursor) ? '' : ctx.eol + containerIndent;
  return { range: { start: cursor, end: cursor }, indent, prefix, suffix };
}

export interface TopLevelOptions {
  /** Place before or after the top-level statement containing the cursor (default 'after'). */
  position?: 'before' | 'after';
  /** Force insertion right after the import block (used for imports/constants). */
  afterImports?: boolean;
  /** Offset whose top-level statement is used as the anchor (defaults to the cursor). */
  anchor?: number;
}

function blankLineFollows(text: string, offset: number, eol: string): boolean {
  const rest = text.slice(offset);
  if (rest.trim().length === 0) {
    return true;
  }
  return rest.startsWith(eol + eol) || rest.startsWith('\n\n') || rest.startsWith('\r\n\r\n');
}

/** Plans insertion of a top-level declaration (function, class, interface, type, enum, constant). */
export function planTopLevelInsertion(ctx: CodeContext, options: TopLevelOptions = {}): InsertionPlan {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const text = ctx.text;
  const eol = ctx.eol;
  const position = options.position ?? 'after';

  if (options.afterImports) {
    return planAfterImports(ctx);
  }

  let top = ast.topLevelStatementNode;
  if (options.anchor !== undefined) {
    top = sf.statements.find(
      (s) => s.getStart(sf) <= (options.anchor as number) && (options.anchor as number) <= s.getEnd(),
    );
  }
  if (top && ts.isImportDeclaration(top)) {
    return planAfterImports(ctx);
  }
  if (!top && ctx.currentLine.isBlank && ctx.scope.kind === 'module') {
    return {
      range: { start: ctx.currentLine.start, end: ctx.currentLine.end },
      indent: '',
      prefix: '',
      suffix: '',
      indentFirstLine: true,
    };
  }
  if (!top) {
    // Cursor in leading/trailing trivia: pick the statement after the cursor, else append.
    top = sf.statements.find((s) => s.getStart(sf) >= ctx.cursor);
    if (!top) {
      const last = sf.statements[sf.statements.length - 1];
      if (!last) {
        return {
          range: { start: text.length, end: text.length },
          indent: '',
          prefix: text.trim().length ? eol + eol : '',
          suffix: eol,
        };
      }
      return {
        range: { start: last.getEnd(), end: last.getEnd() },
        indent: '',
        prefix: eol + eol,
        suffix: blankLineFollows(text, last.getEnd(), eol) ? '' : eol,
      };
    }
  }
  if (position === 'before') {
    const fullStart = top.getFullStart();
    if (fullStart === 0) {
      return { range: { start: 0, end: 0 }, indent: '', prefix: '', suffix: eol + eol };
    }
    const trivia = text.slice(fullStart, top.getStart(sf));
    const alreadyBlank = /^\r?\n\s*\r?\n/.test(trivia);
    return {
      range: { start: fullStart, end: fullStart },
      indent: '',
      prefix: eol + eol,
      suffix: alreadyBlank ? '' : eol,
    };
  }
  const end = top.getEnd();
  return {
    range: { start: end, end },
    indent: '',
    prefix: eol + eol,
    suffix: blankLineFollows(text, end, eol) ? '' : eol,
  };
}

/** Position right after the last import declaration (or after leading directives). */
export function planAfterImports(ctx: CodeContext): InsertionPlan {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const text = ctx.text;
  const eol = ctx.eol;
  let last: ts.Statement | undefined;
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression) && stmt === sf.statements[0])
    ) {
      last = stmt;
    } else if (last) {
      break;
    } else if (!ts.isImportDeclaration(stmt)) {
      break;
    }
  }
  if (!last) {
    const hasContent = text.trim().length > 0;
    return { range: { start: 0, end: 0 }, indent: '', prefix: '', suffix: hasContent ? eol + eol : eol };
  }
  const end = last.getEnd();
  return {
    range: { start: end, end },
    indent: '',
    prefix: eol + eol,
    suffix: blankLineFollows(text, end, eol) ? '' : eol,
  };
}

/** Position for a new import declaration: directly after the last import, one per line. */
export function planImportInsertion(ctx: CodeContext): InsertionPlan {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const text = ctx.text;
  const eol = ctx.eol;
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const last = imports[imports.length - 1];
  if (last) {
    const end = last.getEnd();
    return { range: { start: end, end }, indent: '', prefix: eol, suffix: '' };
  }
  // After a leading directive such as 'use client'.
  const first = sf.statements[0];
  if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)) {
    const end = first.getEnd();
    return {
      range: { start: end, end },
      indent: '',
      prefix: eol + eol,
      suffix: blankLineFollows(text, end, eol) ? '' : '',
    };
  }
  const hasContent = text.trim().length > 0;
  // Skip a leading comment block (license header) if present.
  const leading = ts.getLeadingCommentRanges(text, 0);
  let offset = 0;
  if (leading && leading.length > 0 && first && leading[leading.length - 1].end < first.getStart(sf)) {
    const lastComment = leading[leading.length - 1];
    if (
      ts.isImportDeclaration(first) === false &&
      lastComment.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      /^\/\*\*/.test(text.slice(lastComment.pos, lastComment.pos + 3)) === false
    ) {
      offset = lastComment.end;
      return { range: { start: offset, end: offset }, indent: '', prefix: eol + eol, suffix: '' };
    }
  }
  return { range: { start: 0, end: 0 }, indent: '', prefix: '', suffix: hasContent ? eol + eol : eol };
}

export type ClassMemberKind = 'property' | 'constructor' | 'method';

/** Plans insertion of a class member with class-aware ordering (properties → constructor → methods). */
export function planClassMemberInsertion(
  ctx: CodeContext,
  cls: ClassInfo,
  kind: ClassMemberKind,
): InsertionPlan {
  const text = ctx.text;
  const eol = ctx.eol;
  const classIndent = lineIndentAt(text, cls.range.start);
  const indent = classIndent + ctx.indent.unit;

  const cursorInBody =
    ctx.cursor > cls.bodyRange.start && ctx.cursor <= cls.bodyRange.end && ctx.scope.inClassBody;
  if (cursorInBody && ctx.currentLine.isBlank) {
    return {
      range: { start: ctx.currentLine.start, end: ctx.currentLine.end },
      indent,
      prefix: '',
      suffix: '',
      indentFirstLine: true,
    };
  }

  const ownProperties = cls.properties.filter(
    (p) =>
      !cls.constructorRange ||
      p.range.start < cls.constructorRange.start ||
      p.range.start > cls.constructorRange.end,
  );
  const lastProperty = ownProperties.length
    ? ownProperties.reduce((a, b) => (a.range.end > b.range.end ? a : b))
    : undefined;
  const memberEnds = [
    ...cls.properties.map((p) => p.range.end),
    ...cls.methods.map((m) => m.range.end),
    ...(cls.constructorRange ? [cls.constructorRange.end] : []),
  ].filter((e) => e <= cls.bodyRange.end);
  const lastMemberEnd = memberEnds.length ? Math.max(...memberEnds) : undefined;

  let anchor: number | undefined;
  let blankLineBefore = false;
  if (kind === 'property') {
    anchor = lastProperty?.range.end;
  } else if (kind === 'constructor') {
    anchor = lastProperty?.range.end;
    blankLineBefore = !!anchor;
  } else {
    anchor = lastMemberEnd;
    blankLineBefore = !!anchor;
  }

  if (anchor !== undefined) {
    // Include a trailing semicolon that is not part of the member node.
    let end = anchor;
    if (text[end] === ';') {
      end += 1;
    }
    return {
      range: { start: end, end },
      indent,
      prefix: (blankLineBefore ? eol : '') + eol + indent,
      suffix: '',
    };
  }
  // Empty class body (or only members after the anchor kind): insert right after `{`.
  const start = cls.bodyRange.start;
  const between = text.slice(start, cls.bodyRange.end);
  const suffix = between.includes('\n') ? '' : eol + classIndent;
  return { range: { start, end: start }, indent, prefix: eol + indent, suffix };
}

/** Plans insertion of a member inside an interface / type literal body. */
export function planInterfaceMemberInsertion(
  ctx: CodeContext,
  bodyRange: Range,
  declStart: number,
): InsertionPlan {
  const text = ctx.text;
  const eol = ctx.eol;
  const baseIndent = lineIndentAt(text, declStart);
  const indent = baseIndent + ctx.indent.unit;
  if (ctx.currentLine.isBlank && ctx.cursor > bodyRange.start && ctx.cursor <= bodyRange.end) {
    return {
      range: { start: ctx.currentLine.start, end: ctx.currentLine.end },
      indent,
      prefix: '',
      suffix: '',
      indentFirstLine: true,
    };
  }
  const inner = text.slice(bodyRange.start, bodyRange.end);
  const trimmedEnd = bodyRange.start + inner.replace(/\s+$/, '').length;
  if (inner.trim().length === 0) {
    return {
      range: { start: bodyRange.start, end: bodyRange.start },
      indent,
      prefix: eol + indent,
      suffix: inner.includes('\n') ? '' : eol + baseIndent,
    };
  }
  return { range: { start: trimmedEnd, end: trimmedEnd }, indent, prefix: eol + indent, suffix: '' };
}

/** Builds a plain TextEdit from a plan and template code. */
export function editFromPlan(ctx: CodeContext, plan: InsertionPlan, code: string): TextEdit {
  return {
    range: plan.range,
    text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
  };
}
