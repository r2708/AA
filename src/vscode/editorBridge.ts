/**
 * Bridges the pure core and the VS Code editor: builds DocumentSnapshots and applies CommandResults.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { DocumentSnapshot, ProjectInfo, Range } from '../types/context';
import type { CommandResult, TextEdit } from '../types/command';
import { adjustRange } from '../generators/codeWriter';

export function snapshotFromEditor(editor: vscode.TextEditor, project: ProjectInfo): DocumentSnapshot {
  const doc = editor.document;
  const selection = editor.selection;
  const start = doc.offsetAt(selection.start);
  const end = doc.offsetAt(selection.end);
  const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
  const insertSpaces = editor.options.insertSpaces !== false;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  return {
    uri: doc.uri.toString(),
    fileName: doc.uri.fsPath,
    languageId: doc.languageId,
    text: doc.getText(),
    version: doc.version,
    selection: { start, end },
    cursor: doc.offsetAt(selection.active),
    eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    indent: { useTabs: !insertSpaces, size: tabSize, unit: insertSpaces ? ' '.repeat(tabSize) : '\t' },
    workspaceRoot: folder?.uri.fsPath,
    project,
  };
}

function toVsRange(doc: vscode.TextDocument, range: Range): vscode.Range {
  return new vscode.Range(doc.positionAt(range.start), doc.positionAt(range.end));
}

export interface ApplyOptions {
  format: boolean;
}

export interface ApplyOutcome {
  applied: boolean;
  changedRanges: vscode.Range[];
}

/** Applies edits, then the snippet, then creates files. Offsets in the result refer to the original document. */
export async function applyResult(
  editor: vscode.TextEditor,
  result: CommandResult,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  const doc = editor.document;
  const edits: TextEdit[] = result.edits ?? [];
  const changedRanges: vscode.Range[] = [];

  if (edits.length) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      workspaceEdit.replace(doc.uri, toVsRange(doc, edit.range), edit.text);
    }
    const ok = await vscode.workspace.applyEdit(workspaceEdit);
    if (!ok) {
      return { applied: false, changedRanges };
    }
    for (const edit of edits) {
      const start = adjustRangeStart(edit, edits);
      changedRanges.push(new vscode.Range(doc.positionAt(start), doc.positionAt(start + edit.text.length)));
    }
  }

  if (result.snippet) {
    const range = adjustRange(result.snippet.range, edits);
    const vsRange = toVsRange(doc, range);
    const snippet = new vscode.SnippetString(result.snippet.body);
    const ok = await editor.insertSnippet(snippet, vsRange, {
      undoStopBefore: edits.length === 0,
      undoStopAfter: true,
      keepWhitespace: true,
    });
    if (!ok) {
      return { applied: false, changedRanges };
    }
  } else if (result.selectAfter) {
    const range = toVsRange(doc, result.selectAfter);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  if (result.newFile) {
    await createOrAppendFile(result.newFile.path, result.newFile.content, result.newFile.open);
  }

  if (options.format && !result.snippet && changedRanges.length && (result.format ?? true)) {
    await formatRanges(doc, changedRanges);
  }
  return { applied: true, changedRanges };
}

function adjustRangeStart(edit: TextEdit, all: TextEdit[]): number {
  let delta = 0;
  for (const other of all) {
    if (other === edit) {
      continue;
    }
    if (
      other.range.end <= edit.range.start &&
      !(other.range.start === edit.range.start && other.range.end === edit.range.end)
    ) {
      delta += other.text.length - (other.range.end - other.range.start);
    }
  }
  return edit.range.start + delta;
}

async function formatRanges(doc: vscode.TextDocument, ranges: vscode.Range[]): Promise<void> {
  try {
    const union = ranges.reduce((acc, r) => acc.union(r));
    const formatted = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatRangeProvider',
      doc.uri,
      union,
      { tabSize: 2, insertSpaces: true },
    );
    if (formatted && formatted.length) {
      const edit = new vscode.WorkspaceEdit();
      formatted.forEach((e) => edit.replace(doc.uri, e.range, e.newText));
      await vscode.workspace.applyEdit(edit);
    }
  } catch {
    // Formatting is best-effort: no formatter, or the provider failed.
  }
}

async function createOrAppendFile(filePath: string, content: string, open: boolean): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  if (fs.existsSync(filePath)) {
    // Append the body without duplicating import lines.
    const existing = await vscode.workspace.openTextDocument(uri);
    const body = content
      .split('\n')
      .filter((line) => !/^import\b/.test(line))
      .join('\n')
      .replace(/^\s+/, '');
    const edit = new vscode.WorkspaceEdit();
    const end = existing.positionAt(existing.getText().length);
    const eol = existing.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    edit.insert(uri, end, `${existing.getText().endsWith('\n') ? '' : eol}${eol}${body}`);
    await vscode.workspace.applyEdit(edit);
    if (open) {
      await vscode.window.showTextDocument(existing, { preview: false });
    }
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri, { ignoreIfExists: true });
  edit.insert(uri, new vscode.Position(0, 0), content);
  await vscode.workspace.applyEdit(edit);
  if (open) {
    const created = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(created, { preview: false });
  }
}
