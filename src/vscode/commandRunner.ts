import * as vscode from 'vscode';
import type { CommandRegistry } from '../commands/commandRegistry';
import { CodePilotError, type CommandResult, type UserInteraction } from '../types/command';
import type { CodeContext } from '../types/context';
import { ContextAnalyzer } from '../analyzer/contextAnalyzer';
import { isCategoryEnabled, type CodePilotSettings } from '../config/configuration';
import { isSupportedLanguage } from '../analyzer/languageDetector';
import { runSmartAction } from '../smart/smartAction';
import { applyResult, snapshotFromEditor } from './editorBridge';
import type { ProjectInfoProvider } from './projectInfoProvider';
import type { Logger } from '../ui/output';
import type { StatusBar } from '../ui/statusBar';

export interface RunnerDeps {
  registry: CommandRegistry;
  analyzer: ContextAnalyzer;
  projects: ProjectInfoProvider;
  ui: UserInteraction;
  logger: Logger;
  statusBar: StatusBar;
  getSettings(): CodePilotSettings;
}

/**
 * Executes a command end to end:
 * editor → snapshot → analysis → applicability → execute → apply → feedback.
 */
export class CommandRunner {
  constructor(private readonly deps: RunnerDeps) {}

  private analyzeActiveEditor(): { editor: vscode.TextEditor; ctx: CodeContext } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('CodePilot: open a JavaScript or TypeScript file first.');
      return undefined;
    }
    if (!isSupportedLanguage(editor.document.languageId)) {
      void vscode.window.showWarningMessage(
        `CodePilot does not support "${editor.document.languageId}" files yet. Supported: JavaScript, TypeScript, JSX and TSX.`,
      );
      return undefined;
    }
    const snapshot = snapshotFromEditor(editor, this.deps.projects.forDocument(editor.document));
    const ctx = this.deps.analyzer.analyze(snapshot);
    return { editor, ctx };
  }

  async run(commandId: string): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled) {
      void vscode.window.showInformationMessage(
        'CodePilot is disabled. Enable it from the status bar or `codepilot.enabled`.',
      );
      return;
    }
    const command = this.deps.registry.get(commandId);
    if (!command) {
      void vscode.window.showErrorMessage(`CodePilot: unknown command ${commandId}`);
      return;
    }
    if (!isCategoryEnabled(settings, command.category)) {
      void vscode.window.showInformationMessage(
        `CodePilot: the ${command.category} command group is disabled in settings.`,
      );
      return;
    }
    const done = this.deps.statusBar.busy(command.title);
    const started = Date.now();
    try {
      const analyzed = this.analyzeActiveEditor();
      if (!analyzed) {
        return;
      }
      const { editor, ctx } = analyzed;
      const applicability = this.deps.registry.applicability(command, ctx);
      if (!applicability.available) {
        this.deps.logger.info(`${command.id} unavailable: ${applicability.reason}`);
        void vscode.window.showWarningMessage(
          `CodePilot · ${command.title}: ${applicability.reason ?? 'not available here.'}`,
        );
        return;
      }
      const result = await command.execute(ctx, this.deps.ui);
      await this.finish(editor, command.title, result, settings);
      this.deps.logger.info(`${command.id} completed in ${Date.now() - started}ms`);
    } catch (error) {
      this.report(command.title, error);
    } finally {
      done();
    }
  }

  async runSmartAction(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled) {
      void vscode.window.showInformationMessage('CodePilot is disabled.');
      return;
    }
    if (!settings.smartMode) {
      void vscode.window.showInformationMessage(
        'CodePilot Smart Action is disabled (`codepilot.smartMode`).',
      );
      return;
    }
    try {
      const analyzed = this.analyzeActiveEditor();
      if (!analyzed) {
        return;
      }
      const { editor, ctx } = analyzed;
      const result = await runSmartAction(this.filteredRegistry(settings), ctx, this.deps.ui);
      await this.finish(editor, 'Smart Action', result, settings);
    } catch (error) {
      this.report('Smart Action', error);
    }
  }

  private filteredRegistry(settings: CodePilotSettings): CommandRegistry {
    const registry = this.deps.registry;
    const filtered = Object.create(registry) as CommandRegistry;
    filtered.available = (ctx: CodeContext) =>
      registry.available(ctx).filter((a) => isCategoryEnabled(settings, a.command.category));
    return filtered;
  }

  private async finish(
    editor: vscode.TextEditor,
    title: string,
    result: CommandResult,
    settings: CodePilotSettings,
  ): Promise<void> {
    if (result.cancelled) {
      return;
    }
    if (editor.document.isClosed) {
      void vscode.window.showWarningMessage(
        'CodePilot: the document was closed before the change could be applied.',
      );
      return;
    }
    const outcome = await applyResult(editor, result, { format: settings.formatAfterGeneration });
    if (!outcome.applied) {
      void vscode.window.showErrorMessage(
        `CodePilot · ${title}: the edit could not be applied (the document may have changed).`,
      );
      return;
    }
    if (result.message) {
      this.deps.logger.info(`${title}: ${result.message}`);
      if (settings.showNotifications) {
        void vscode.window.setStatusBarMessage(`$(rocket) CodePilot: ${result.message}`, 5000);
      }
    }
  }

  private report(title: string, error: unknown): void {
    if (error instanceof CodePilotError) {
      this.deps.logger.info(`${title}: ${error.kind}: ${error.message}`);
      void vscode.window.showWarningMessage(`CodePilot · ${title}: ${error.message}`);
      return;
    }
    this.deps.logger.error(`${title} failed`, error);
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window
      .showErrorMessage(`CodePilot · ${title} failed: ${message}`, 'Show Log')
      .then((choice) => {
        if (choice === 'Show Log') {
          this.deps.logger.show();
        }
      });
  }
}
