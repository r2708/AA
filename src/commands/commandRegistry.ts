import type { CodeContext } from '../types/context';
import type { Applicability, CommandCategory, CommandDefinition } from '../types/command';

export const COMMAND_PREFIX = 'codepilot';

/**
 * Central registry: the single source of truth for every command, its palette title,
 * default keybinding and context predicate. Smart Action queries it for applicable commands
 * and the manifest sync script derives package.json contributions from it.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  register(...definitions: CommandDefinition[]): void {
    for (const def of definitions) {
      if (this.commands.has(def.id)) {
        throw new Error(`Duplicate command id: ${def.id}`);
      }
      this.commands.set(def.id, def);
    }
  }

  get(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  all(): CommandDefinition[] {
    return [...this.commands.values()];
  }

  byCategory(category: CommandCategory): CommandDefinition[] {
    return this.all().filter((c) => c.category === category);
  }

  supportsLanguage(def: CommandDefinition, languageId: string): boolean {
    return def.supportedLanguages === 'all' || def.supportedLanguages.includes(languageId);
  }

  /** Applicability of a command for a context, including language + selection gating. */
  applicability(def: CommandDefinition, ctx: CodeContext): Applicability {
    if (!this.supportsLanguage(def, ctx.language.id)) {
      return { available: false, reason: `${def.title} is not available for ${ctx.language.id} files.` };
    }
    if (def.requiresSelection && ctx.selection.kind === 'none') {
      return { available: false, reason: `${def.title} needs a selection.` };
    }
    try {
      return def.canExecute(ctx);
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Commands that can run in the given context, with their applicability. */
  available(ctx: CodeContext): { command: CommandDefinition; applicability: Applicability }[] {
    const result: { command: CommandDefinition; applicability: Applicability }[] = [];
    for (const command of this.commands.values()) {
      const applicability = this.applicability(command, ctx);
      if (applicability.available) {
        result.push({ command, applicability });
      }
    }
    return result;
  }
}

/** Identity helper that keeps command definitions strongly typed and terse. */
export function defineCommand(def: CommandDefinition): CommandDefinition {
  return def;
}
