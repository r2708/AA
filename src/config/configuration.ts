import type { CommandCategory } from '../types/command';

export interface CodePilotSettings {
  enabled: boolean;
  smartMode: boolean;
  react: boolean;
  backend: boolean;
  testing: boolean;
  refactoring: boolean;
  formatAfterGeneration: boolean;
  showNotifications: boolean;
  logLevel: 'off' | 'error' | 'info' | 'debug';
}

export const DEFAULT_SETTINGS: CodePilotSettings = {
  enabled: true,
  smartMode: true,
  react: true,
  backend: true,
  testing: true,
  refactoring: true,
  formatAfterGeneration: true,
  showNotifications: true,
  logLevel: 'info',
};

export function isCategoryEnabled(settings: CodePilotSettings, category: CommandCategory): boolean {
  switch (category) {
    case 'react':
      return settings.react;
    case 'backend':
      return settings.backend;
    case 'testing':
      return settings.testing;
    case 'refactoring':
      return settings.refactoring;
    case 'smart':
      return settings.smartMode;
    default:
      return true;
  }
}

/** Settings contributed to package.json (kept here so the manifest sync script and the reader agree). */
export const SETTINGS_SCHEMA = {
  'codepilot.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable or disable all CodePilot commands and keybindings.',
  },
  'codepilot.smartMode': {
    type: 'boolean',
    default: true,
    description: 'Enable the Smart Action command (context-aware action picker).',
  },
  'codepilot.react.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable the React command group.',
  },
  'codepilot.backend.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable the backend (API/controller/service) command group.',
  },
  'codepilot.testing.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable the testing command group.',
  },
  'codepilot.refactoring.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable the refactoring command group.',
  },
  'codepilot.formatAfterGeneration': {
    type: 'boolean',
    default: true,
    description:
      'Run the document range formatter over code changed by transformations (not applied while a snippet with tab stops is active).',
  },
  'codepilot.showNotifications': {
    type: 'boolean',
    default: true,
    description: 'Show informational notifications after successful commands.',
  },
  'codepilot.logLevel': {
    type: 'string',
    enum: ['off', 'error', 'info', 'debug'],
    default: 'info',
    description: 'Verbosity of the CodePilot output channel.',
  },
} as const;
