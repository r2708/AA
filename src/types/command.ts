import type { CodeContext, Range } from './context';

export type CommandCategory =
  'core' | 'controlFlow' | 'imports' | 'react' | 'backend' | 'testing' | 'refactoring' | 'smart' | 'ai';

export interface TextEdit {
  range: Range;
  text: string;
}

/**
 * A VS Code snippet (supports `${1:placeholder}`, `$0`, choices and transforms)
 * that replaces `range`. At most one snippet per result.
 */
export interface SnippetInsertion {
  range: Range;
  body: string;
}

export interface FileCreation {
  /** Absolute path of the file to create. */
  path: string;
  content: string;
  open: boolean;
}

export interface CommandResult {
  /** Plain text edits applied atomically (offsets refer to the ORIGINAL document). */
  edits?: TextEdit[];
  /** Snippet applied after the plain edits (offsets refer to the document AFTER `edits`). */
  snippet?: SnippetInsertion;
  newFile?: FileCreation;
  /** Informational message shown to the user (only when notifications are enabled). */
  message?: string;
  /** Range (in the final document) to select/reveal after applying edits. */
  selectAfter?: Range;
  /** Whether the document formatter should run afterwards (defaults to the setting). */
  format?: boolean;
  /** The user cancelled a prompt; nothing was changed. */
  cancelled?: boolean;
}

export interface InputOptions {
  prompt: string;
  value?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value: T;
}

export interface PickOptions {
  title?: string;
  placeholder?: string;
}

/** Abstraction over VS Code's Quick Pick / Input Box so commands stay testable. */
export interface UserInteraction {
  input(options: InputOptions): Promise<string | undefined>;
  pick<T>(items: PickItem<T>[], options?: PickOptions): Promise<T | undefined>;
}

export interface Applicability {
  available: boolean;
  /** Why the command is unavailable (shown to the user). */
  reason?: string;
  /** 0-100 relevance score used by Smart Action ranking. */
  score?: number;
  /** Human readable description of what the command would do in this context. */
  detail?: string;
}

export interface KeybindingSpec {
  key: string;
  mac?: string;
  /** Extra `when` clause (AND-ed with the default editor/language guard). */
  when?: string;
}

export interface CommandDefinition {
  /** Fully qualified command id, e.g. `codepilot.createFunction`. */
  id: string;
  /** Title shown in the palette without the "CodePilot: " prefix. */
  title: string;
  category: CommandCategory;
  description: string;
  keybinding?: KeybindingSpec;
  /** Language ids this command supports, or 'all'. */
  supportedLanguages: string[] | 'all';
  requiresSelection?: boolean;
  canExecute(ctx: CodeContext): Applicability;
  execute(ctx: CodeContext, ui: UserInteraction): Promise<CommandResult>;
}

export type CodePilotErrorKind =
  | 'noEditor'
  | 'unsupportedLanguage'
  | 'invalidSelection'
  | 'unavailable'
  | 'parseError'
  | 'duplicate'
  | 'invalidTransformation'
  | 'disabled';

export class CodePilotError extends Error {
  constructor(
    public readonly kind: CodePilotErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CodePilotError';
  }
}
