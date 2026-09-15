import * as vscode from 'vscode';
import { DEFAULT_SETTINGS, type CodePilotSettings } from '../config/configuration';

export function readSettings(): CodePilotSettings {
  const cfg = vscode.workspace.getConfiguration('codepilot');
  return {
    enabled: cfg.get<boolean>('enabled', DEFAULT_SETTINGS.enabled),
    smartMode: cfg.get<boolean>('smartMode', DEFAULT_SETTINGS.smartMode),
    react: cfg.get<boolean>('react.enabled', DEFAULT_SETTINGS.react),
    backend: cfg.get<boolean>('backend.enabled', DEFAULT_SETTINGS.backend),
    testing: cfg.get<boolean>('testing.enabled', DEFAULT_SETTINGS.testing),
    refactoring: cfg.get<boolean>('refactoring.enabled', DEFAULT_SETTINGS.refactoring),
    formatAfterGeneration: cfg.get<boolean>('formatAfterGeneration', DEFAULT_SETTINGS.formatAfterGeneration),
    showNotifications: cfg.get<boolean>('showNotifications', DEFAULT_SETTINGS.showNotifications),
    logLevel: cfg.get<CodePilotSettings['logLevel']>('logLevel', DEFAULT_SETTINGS.logLevel),
  };
}
