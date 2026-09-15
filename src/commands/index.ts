import { CommandRegistry } from './commandRegistry';
import { coreCommands } from './core/coreCommands';
import { controlFlowCommands } from './controlFlow/controlFlowCommands';
import { importCommands } from './imports/importCommands';
import { reactCommands } from './react/reactCommands';
import { backendCommands } from './backend/backendCommands';
import { testingCommands } from './testing/testingCommands';
import { refactoringCommands } from './refactoring/refactoringCommands';

export { META_COMMANDS } from './metaCommands';
export { CommandRegistry } from './commandRegistry';

/** Builds the registry with every built-in command. */
export function createRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(
    ...coreCommands,
    ...controlFlowCommands,
    ...importCommands,
    ...refactoringCommands,
    ...reactCommands,
    ...backendCommands,
    ...testingCommands,
  );
  return registry;
}
