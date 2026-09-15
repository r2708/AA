/**
 * Test harness: builds contexts from annotated source, runs commands with a scripted UI
 * and resolves snippet placeholders so tests can assert on the final document text.
 *
 * Markers in source strings:
 *   `<|>`          cursor position (single)
 *   `[[` ... `]]`  selection (cursor is placed at the selection end)
 */
import * as assert from 'assert';
import type { CodeContext, DocumentSnapshot, ProjectInfo } from '../../src/types/context';
import type {
  CommandDefinition,
  CommandResult,
  InputOptions,
  PickItem,
  PickOptions,
  UserInteraction,
} from '../../src/types/command';
import { ContextAnalyzer } from '../../src/analyzer/contextAnalyzer';
import { applyTextEdits, adjustRange } from '../../src/generators/codeWriter';
import { emptyProjectInfo } from '../../src/analyzer/projectDetector';

export interface SnapshotOptions {
  languageId?: string;
  fileName?: string;
  useTabs?: boolean;
  tabSize?: number;
  eol?: '\n' | '\r\n';
  project?: Partial<ProjectInfo>;
}

export interface Annotated {
  text: string;
  cursor: number;
  selection: { start: number; end: number };
}

export function parseMarkers(source: string): Annotated {
  let text = source;
  let selStart = -1;
  let selEnd = -1;
  const open = text.indexOf('[[');
  if (open !== -1) {
    const close = text.indexOf(']]', open + 2);
    if (close === -1) {
      throw new Error('Unclosed [[ selection marker');
    }
    text = text.slice(0, open) + text.slice(open + 2, close) + text.slice(close + 2);
    selStart = open;
    selEnd = close - 2;
  }
  let cursor = text.indexOf('<|>');
  if (cursor !== -1) {
    text = text.slice(0, cursor) + text.slice(cursor + 3);
    if (selStart !== -1) {
      throw new Error('Use either a <|> cursor marker or a [[selection]], not both');
    }
  }
  if (selStart !== -1) {
    return { text, cursor: selEnd, selection: { start: selStart, end: selEnd } };
  }
  if (cursor === -1) {
    cursor = text.length;
  }
  return { text, cursor, selection: { start: cursor, end: cursor } };
}

export function buildSnapshot(source: string, options: SnapshotOptions = {}): DocumentSnapshot {
  const annotated = parseMarkers(source);
  const languageId = options.languageId ?? 'typescript';
  const ext =
    languageId === 'typescriptreact'
      ? 'tsx'
      : languageId === 'javascriptreact'
        ? 'jsx'
        : languageId === 'javascript'
          ? 'js'
          : 'ts';
  const fileName = options.fileName ?? `/project/src/file.${ext}`;
  const tabSize = options.tabSize ?? 2;
  const useTabs = options.useTabs ?? false;
  return {
    uri: `file://${fileName}`,
    fileName,
    languageId,
    text: annotated.text,
    version: 1,
    selection: annotated.selection,
    cursor: annotated.cursor,
    eol: options.eol ?? '\n',
    indent: { useTabs, size: tabSize, unit: useTabs ? '\t' : ' '.repeat(tabSize) },
    workspaceRoot: '/project',
    project: { ...emptyProjectInfo(), ...(options.project ?? {}) },
  };
}

const analyzer = new ContextAnalyzer();

export function analyze(source: string, options: SnapshotOptions = {}): CodeContext {
  return analyzer.analyze(buildSnapshot(source, options));
}

/** Scripted user interaction: answers prompts from queues, records what was asked. */
export class ScriptedUI implements UserInteraction {
  readonly asked: { kind: 'input' | 'pick'; title?: string; labels?: string[] }[] = [];
  constructor(
    private readonly picks: (string | number | undefined)[] = [],
    private readonly inputs: (string | undefined)[] = [],
  ) {}

  async input(options: InputOptions): Promise<string | undefined> {
    this.asked.push({ kind: 'input', title: options.prompt });
    if (this.inputs.length) {
      return this.inputs.shift();
    }
    return options.value;
  }

  async pick<T>(items: PickItem<T>[], options: PickOptions = {}): Promise<T | undefined> {
    this.asked.push({ kind: 'pick', title: options.title, labels: items.map((i) => i.label) });
    if (!this.picks.length) {
      return items[0]?.value;
    }
    const choice = this.picks.shift();
    if (choice === undefined) {
      return undefined;
    }
    if (typeof choice === 'number') {
      return items[choice]?.value;
    }
    const found = items.find((i) => i.label === choice || i.label.includes(choice));
    if (!found) {
      throw new Error(`No pick item matching "${choice}" in [${items.map((i) => i.label).join(', ')}]`);
    }
    return found.value;
  }
}

// ---------------------------------------------------------------------------
// Snippet placeholder resolution (subset of the VS Code snippet grammar)
// ---------------------------------------------------------------------------

interface ResolveState {
  values: Map<number, string>;
}

function applyFormat(format: string, match: RegExpExecArray, _state: ResolveState): string {
  return format.replace(
    /\$\{(\d+)(?::\/(upcase|downcase|capitalize|camelcase|pascalcase))?\}|\$(\d+)/g,
    (_m, g1, transform, g3) => {
      const index = Number(g1 ?? g3);
      const value = match[index] ?? '';
      switch (transform) {
        case 'upcase':
          return value.toUpperCase();
        case 'downcase':
          return value.toLowerCase();
        case 'capitalize':
          return value.charAt(0).toUpperCase() + value.slice(1);
        case 'camelcase':
          return value.charAt(0).toLowerCase() + value.slice(1);
        case 'pascalcase':
          return value.charAt(0).toUpperCase() + value.slice(1);
        default:
          return value;
      }
    },
  );
}

/** Resolves `${1:default}`, `$1`, `${1|a,b|}` and `${1/regex/format/}` into plain text. */
export function resolveSnippet(body: string): string {
  const state: ResolveState = { values: new Map() };
  const parse = (input: string): string => {
    let out = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\\' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '$') {
        // $0 / $1
        const simple = /^\$(\d+)/.exec(input.slice(i));
        if (simple) {
          const idx = Number(simple[1]);
          out += state.values.get(idx) ?? '';
          i += simple[0].length;
          continue;
        }
        if (input[i + 1] === '{') {
          // find matching brace
          let depth = 0;
          let j = i + 1;
          for (; j < input.length; j += 1) {
            if (input[j] === '\\') {
              j += 1;
              continue;
            }
            if (input[j] === '{') {
              depth += 1;
            } else if (input[j] === '}') {
              depth -= 1;
              if (depth === 0) {
                break;
              }
            }
          }
          const inner = input.slice(i + 2, j);
          i = j + 1;
          const choice = /^(\d+)\|(.*)\|$/s.exec(inner);
          if (choice) {
            const first = choice[2].split(/(?<!\\),/)[0].replace(/\\,/g, ',');
            state.values.set(Number(choice[1]), first);
            out += first;
            continue;
          }
          const transform = /^(\d+)\/(.*?)(?<!\\)\/(.*?)(?<!\\)\/([gimsuy]*)$/s.exec(inner);
          if (transform) {
            const idx = Number(transform[1]);
            const value = state.values.get(idx) ?? '';
            const re = new RegExp(transform[2], transform[4]);
            const m = re.exec(value);
            out += m ? value.replace(re, () => applyFormat(transform[3], m, state)) : value;
            continue;
          }
          const placeholder = /^(\d+)(?::([\s\S]*))?$/.exec(inner);
          if (placeholder) {
            const idx = Number(placeholder[1]);
            const def = placeholder[2] !== undefined ? parse(placeholder[2]) : (state.values.get(idx) ?? '');
            if (!state.values.has(idx) || placeholder[2] !== undefined) {
              state.values.set(idx, def);
            }
            out += def;
            continue;
          }
          out += `\${${inner}}`;
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  };
  // Two passes so transforms referencing later-defined placeholders resolve.
  parse(body);
  return parse(body);
}

/** Applies a CommandResult to the original text (edits, then snippet with resolved placeholders). */
export function applyResult(text: string, result: CommandResult): string {
  let next = text;
  const edits = result.edits ?? [];
  if (edits.length) {
    next = applyTextEdits(next, edits);
  }
  if (result.snippet) {
    const range = adjustRange(result.snippet.range, edits);
    next = next.slice(0, range.start) + resolveSnippet(result.snippet.body) + next.slice(range.end);
  }
  return next;
}

export interface RunOutcome {
  ctx: CodeContext;
  result: CommandResult;
  text: string;
  ui: ScriptedUI;
}

/** Runs a command against annotated source and returns the resulting document text. */
export async function run(
  command: CommandDefinition,
  source: string,
  options: SnapshotOptions & {
    picks?: (string | number | undefined)[];
    inputs?: (string | undefined)[];
  } = {},
): Promise<RunOutcome> {
  const ctx = analyze(source, options);
  const ui = new ScriptedUI(options.picks, options.inputs);
  const applicability = command.canExecute(ctx);
  assert.ok(applicability.available, `${command.id} not available: ${applicability.reason}`);
  const result = await command.execute(ctx, ui);
  const text = result.cancelled ? ctx.text : applyResult(ctx.text, result);
  return { ctx, result, text, ui };
}

/** Asserts the command is unavailable and returns the reason. */
export function expectUnavailable(
  command: CommandDefinition,
  source: string,
  options: SnapshotOptions = {},
): string {
  const ctx = analyze(source, options);
  const applicability = command.canExecute(ctx);
  assert.strictEqual(applicability.available, false, `${command.id} should be unavailable`);
  return applicability.reason ?? '';
}

/** Normalises whitespace for looser comparisons. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export { assert };
