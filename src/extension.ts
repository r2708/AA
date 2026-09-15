import * as vscode from 'vscode';
import { createRegistry, META_COMMANDS } from './commands';
import { ContextAnalyzer } from './analyzer/contextAnalyzer';
import { SUPPORTED_LANGUAGE_IDS, isSupportedLanguage } from './analyzer/languageDetector';
import { AIProviderRegistry, type AIProvider } from './ai/aiProvider';
import type { LanguageAdapter } from './languages/languageAdapter';
import type { CommandDefinition } from './types/command';
import { readSettings } from './vscode/settings';
import { ProjectInfoProvider } from './vscode/projectInfoProvider';
import { CommandRunner } from './vscode/commandRunner';
import { Logger } from './ui/output';
import { StatusBar } from './ui/statusBar';
import { VsCodeUserInteraction } from './ui/quickPick';

/** Public API returned from activate() so other extensions can extend CodePilot. */
export interface CodePilotApi {
  registerAIProvider(provider: AIProvider): vscode.Disposable;
  registerLanguageAdapter(adapter: LanguageAdapter): void;
  registerCommand(definition: CommandDefinition): vscode.Disposable;
}

export function activate(context: vscode.ExtensionContext): CodePilotApi {
  const logger = new Logger();
  const registry = createRegistry();
  const analyzer = new ContextAnalyzer();
  const projects = new ProjectInfoProvider();
  const statusBar = new StatusBar();
  const aiProviders = new AIProviderRegistry();
  let settings = readSettings();
  logger.setLevel(settings.logLevel);

  const runner = new CommandRunner({
    registry,
    analyzer,
    projects,
    ui: new VsCodeUserInteraction(),
    logger,
    statusBar,
    getSettings: () => settings,
  });

  const refreshContextKeys = (): void => {
    void vscode.commands.executeCommand('setContext', 'codepilot.enabled', settings.enabled);
    void vscode.commands.executeCommand('setContext', 'codepilot.supportedLanguages', [
      ...SUPPORTED_LANGUAGE_IDS,
    ]);
    const editor = vscode.window.activeTextEditor;
    statusBar.update(settings.enabled, !!editor && isSupportedLanguage(editor.document.languageId));
  };

  for (const command of registry.all()) {
    context.subscriptions.push(vscode.commands.registerCommand(command.id, () => runner.run(command.id)));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('codepilot.smartAction', () => runner.runSmartAction()),
    vscode.commands.registerCommand('codepilot.toggle', async () => {
      await vscode.workspace
        .getConfiguration('codepilot')
        .update('enabled', !settings.enabled, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('codepilot.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:codepilot-dev.codepilot'),
    ),
    vscode.commands.registerCommand('codepilot.showOutput', () => logger.show()),
    vscode.commands.registerCommand('codepilot.showCommands', () =>
      vscode.commands.executeCommand('workbench.action.quickOpen', '>CodePilot: '),
    ),
    vscode.commands.registerCommand('codepilot.statusMenu', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(zap) Smart Action', description: 'Ctrl+Shift+Space', command: 'codepilot.smartAction' },
          { label: '$(list-unordered) Show All Commands', command: 'codepilot.showCommands' },
          {
            label: settings.enabled ? '$(circle-slash) Disable CodePilot' : '$(check) Enable CodePilot',
            command: 'codepilot.toggle',
          },
          { label: '$(settings-gear) Open Settings', command: 'codepilot.openSettings' },
          { label: '$(output) Show Output Log', command: 'codepilot.showOutput' },
        ],
        {
          title: 'CodePilot',
          placeHolder: `CodePilot is ${settings.enabled ? 'ON' : 'OFF'} · ${registry.all().length} context-aware commands`,
        },
      );
      if (picked) {
        await vscode.commands.executeCommand(picked.command);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codepilot')) {
        settings = readSettings();
        logger.setLevel(settings.logLevel);
        refreshContextKeys();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => refreshContextKeys()),
    logger,
    projects,
    statusBar,
  );

  // Every meta command contributed to the manifest must have a handler registered above.
  const registeredMeta = new Set([
    'codepilot.smartAction',
    'codepilot.toggle',
    'codepilot.openSettings',
    'codepilot.showOutput',
    'codepilot.showCommands',
    'codepilot.statusMenu',
  ]);
  for (const meta of META_COMMANDS) {
    if (!registeredMeta.has(meta.id)) {
      logger.error(`Meta command ${meta.id} is declared in the manifest but has no handler`);
    }
  }

  refreshContextKeys();
  logger.info(`CodePilot activated with ${registry.all().length} commands`);

  return {
    registerAIProvider(provider) {
      const unregister = aiProviders.register(provider);
      logger.info(`AI provider registered: ${provider.displayName}`);
      return new vscode.Disposable(unregister);
    },
    registerLanguageAdapter(adapter) {
      analyzer.languages.register(adapter);
      logger.info(`Language adapter registered: ${adapter.displayName}`);
    },
    registerCommand(definition) {
      registry.register(definition);
      const disposable = vscode.commands.registerCommand(definition.id, () => runner.run(definition.id));
      context.subscriptions.push(disposable);
      return disposable;
    },
  };
}

export function deactivate(): void {
  // Disposables are handled by the extension context.
}
