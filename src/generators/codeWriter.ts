/**
 * Utilities for emitting code that matches the user's file conventions
 * (indentation unit, line endings, quotes, semicolons) and for building snippets.
 */
import type { CodeContext, Range } from '../types/context';
import type { CommandResult, TextEdit } from '../types/command';

/**
 * Converts template code written with `\n` and leading `\t` characters into the
 * document's line endings and indentation unit, prefixing `baseIndent` to every
 * line except the first (which is expected to be placed after existing indentation).
 */
export function renderCode(code: string, ctx: CodeContext, baseIndent = '', indentFirstLine = false): string {
  const lines = code.split('\n');
  return lines
    .map((line, i) => {
      const converted = line.replace(/^\t+/, (tabs) => ctx.indent.unit.repeat(tabs.length));
      if (converted.length === 0) {
        return '';
      }
      return i === 0 && !indentFirstLine ? converted : baseIndent + converted;
    })
    .join(ctx.eol);
}

/** Adds one indentation unit to every non-empty line after the first. */
export function indentSubsequentLines(text: string, unit: string, eol: string): string {
  const lines = text.split(/\r?\n/);
  return lines.map((line, i) => (i === 0 || line.length === 0 ? line : unit + line)).join(eol);
}

/** Adds one indentation unit to every non-empty line (including the first). */
export function indentAllLines(text: string, unit: string, eol: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length === 0 ? line : unit + line))
    .join(eol);
}

/** Removes `indent` from the start of every line after the first (used when moving code out of a scope). */
export function dedentSubsequentLines(text: string, indent: string, eol: string): string {
  if (!indent) {
    return text.split(/\r?\n/).join(eol);
  }
  return text
    .split(/\r?\n/)
    .map((line, i) =>
      i === 0
        ? line
        : line.startsWith(indent)
          ? line.slice(indent.length)
          : line.replace(/^[ \t]+/, (ws) => ws.slice(Math.min(ws.length, indent.length))),
    )
    .join(eol);
}

/** Escapes text for literal inclusion inside a VS Code snippet body. */
export function escapeSnippet(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/\}/g, '\\}');
}

export function semi(ctx: CodeContext): string {
  return ctx.style.semicolons ? ';' : '';
}

export function quote(ctx: CodeContext, value: string): string {
  const q = ctx.style.quote;
  return `${q}${value.replace(new RegExp(q, 'g'), `\\${q}`)}${q}`;
}

/** `: type` in TypeScript files, empty in JavaScript files. */
export function typeAnnotation(ctx: CodeContext, type: string | undefined): string {
  if (!ctx.language.isTypeScript || !type) {
    return '';
  }
  return `: ${type}`;
}

/** Placeholder-aware type annotation for snippets: `: ${n:type}` in TS, empty in JS. */
export function typePlaceholder(ctx: CodeContext, index: number, defaultType: string): string {
  if (!ctx.language.isTypeScript) {
    return '';
  }
  return `: \${${index}:${defaultType}}`;
}

export function replaceRangeEdit(range: Range, text: string): TextEdit {
  return { range, text };
}

export function insertEdit(offset: number, text: string): TextEdit {
  return { range: { start: offset, end: offset }, text };
}

/** Applies plain text edits to a string (edits must not overlap). */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start - a.range.start || b.range.end - a.range.end);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.range.start) + edit.text + result.slice(edit.range.end);
  }
  return result;
}

/** Shifts an offset in the original document to the document produced by `edits`. */
export function adjustOffset(offset: number, edits: readonly TextEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    if (edit.range.end <= offset) {
      delta += edit.text.length - (edit.range.end - edit.range.start);
    } else if (edit.range.start < offset) {
      // Offset is inside a replaced range: clamp to the end of the replacement.
      delta += edit.range.start + edit.text.length - offset;
    }
  }
  return offset + delta;
}

export function adjustRange(range: Range, edits: readonly TextEdit[]): Range {
  return { start: adjustOffset(range.start, edits), end: adjustOffset(range.end, edits) };
}

/** Helper for the common "insert a rendered snippet at a planned position" result. */
export function snippetResult(range: Range, body: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { snippet: { range, body }, ...extra };
}

export function editsResult(edits: TextEdit[], extra: Partial<CommandResult> = {}): CommandResult {
  return { edits, ...extra };
}

/** Wraps a snippet body as an insertion whose first line continues the current line. */
export function withPrefixSuffix(prefix: string, body: string, suffix: string): string {
  return escapeSnippet(prefix) + body + escapeSnippet(suffix);
}
