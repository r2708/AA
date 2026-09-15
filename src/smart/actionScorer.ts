import type { CodeContext } from '../types/context';
import type { Applicability, CommandCategory, CommandDefinition } from '../types/command';

export interface RankedAction {
  command: CommandDefinition;
  score: number;
  detail: string;
}

/** Context-dependent bonus per category so the most relevant family surfaces first. */
function categoryBonus(category: CommandCategory, ctx: CodeContext): number {
  switch (category) {
    case 'testing':
      return ctx.isTestFile ? 15 : -10;
    case 'react':
      return ctx.react.isReact ? 8 : -30;
    case 'backend':
      return ctx.react.isReact ? -30 : ctx.project.backendFramework ? 5 : -5;
    case 'refactoring':
      return ctx.selection.kind === 'none' ? -5 : 0;
    case 'controlFlow':
      return ctx.selection.kind === 'statements' ? 5 : 0;
    default:
      return 0;
  }
}

export function scoreAction(
  command: CommandDefinition,
  applicability: Applicability,
  ctx: CodeContext,
): number {
  const base = applicability.score ?? 20;
  return Math.max(0, Math.min(100, base + categoryBonus(command.category, ctx)));
}

/**
 * Ranks available commands. Commands with a low context-specific score are only
 * shown when nothing better is available, so the Quick Pick stays short.
 */
export function rankActions(
  available: { command: CommandDefinition; applicability: Applicability }[],
  ctx: CodeContext,
  options: { minScore?: number; maxItems?: number; minItems?: number } = {},
): RankedAction[] {
  const minScore = options.minScore ?? 40;
  const maxItems = options.maxItems ?? 8;
  const minItems = options.minItems ?? 4;
  const ranked = available
    .filter(({ command }) => command.category !== 'smart' && command.category !== 'ai')
    .map(({ command, applicability }) => ({
      command,
      score: scoreAction(command, applicability, ctx),
      detail: applicability.detail ?? command.description,
    }))
    .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
    // Core and refactoring commands can resolve to the same action; show it once.
    .filter((item, index, all) => all.findIndex((other) => other.detail === item.detail) === index);
  const strong = ranked.filter((r) => r.score >= minScore);
  if (strong.length >= minItems) {
    return strong.slice(0, maxItems);
  }
  return ranked
    .filter((r) => r.score >= 15)
    .slice(0, Math.max(minItems, Math.min(maxItems, strong.length + 2)));
}
