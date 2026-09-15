import type { CodeContext } from '../types/context';
import type { CommandResult, PickItem, UserInteraction } from '../types/command';
import type { CommandRegistry } from '../commands/commandRegistry';
import { rankActions, type RankedAction } from './actionScorer';

export const SMART_ACTION_COMMAND_ID = 'codepilot.smartAction';

export function smartActions(registry: CommandRegistry, ctx: CodeContext): RankedAction[] {
  return rankActions(registry.available(ctx), ctx);
}

const CATEGORY_LABELS: Record<string, string> = {
  core: 'Create',
  controlFlow: 'Control flow',
  imports: 'Imports & expressions',
  react: 'React',
  backend: 'Backend',
  testing: 'Testing',
  refactoring: 'Refactoring',
};

/** Shows the ranked actions in a Quick Pick and runs the chosen one. */
export async function runSmartAction(
  registry: CommandRegistry,
  ctx: CodeContext,
  ui: UserInteraction,
): Promise<CommandResult> {
  const actions = smartActions(registry, ctx);
  if (actions.length === 0) {
    return {
      message:
        'No CodePilot action applies here. Select code or move the cursor into a function, class or component.',
    };
  }
  const items: PickItem<RankedAction>[] = actions.map((a) => ({
    label: a.command.title,
    description: a.detail,
    detail: CATEGORY_LABELS[a.command.category] ?? a.command.category,
    value: a,
  }));
  const picked = await ui.pick(items, {
    title: 'CodePilot Smart Action',
    placeholder:
      ctx.selection.kind === 'none' ? 'Actions for the cursor position' : 'Actions for the selection',
  });
  if (!picked) {
    return { cancelled: true };
  }
  return picked.command.execute(ctx, ui);
}
