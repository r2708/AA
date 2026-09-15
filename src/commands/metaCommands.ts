/**
 * Extension-level commands that are not code generators (registered directly by extension.ts).
 */
export interface MetaCommand {
  id: string;
  title: string;
  keybinding?: { key: string; mac?: string; when?: string };
  /** Palette `when` clause; undefined means always visible. */
  paletteWhen?: string;
}

export const META_COMMANDS: MetaCommand[] = [
  {
    id: 'codepilot.smartAction',
    title: 'Smart Action',
    keybinding: { key: 'ctrl+shift+space', when: 'editorTextFocus && codepilot.enabled' },
    paletteWhen: 'editorLangId in codepilot.supportedLanguages',
  },
  { id: 'codepilot.toggle', title: 'Enable / Disable' },
  { id: 'codepilot.showCommands', title: 'Show All Commands' },
  { id: 'codepilot.openSettings', title: 'Open Settings' },
  { id: 'codepilot.statusMenu', title: 'Status Menu' },
  { id: 'codepilot.showOutput', title: 'Show Output Log' },
];
