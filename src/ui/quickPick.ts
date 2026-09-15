import * as vscode from 'vscode';
import type { InputOptions, PickItem, PickOptions, UserInteraction } from '../types/command';

/** VS Code implementation of the UserInteraction abstraction used by commands. */
export class VsCodeUserInteraction implements UserInteraction {
  async input(options: InputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt: options.prompt,
      value: options.value,
      placeHolder: options.placeholder,
      validateInput: options.validate,
      ignoreFocusOut: false,
    });
  }

  async pick<T>(items: PickItem<T>[], options: PickOptions = {}): Promise<T | undefined> {
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({ label: item.label, description: item.description, detail: item.detail, item })),
      {
        title: options.title,
        placeHolder: options.placeholder,
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    return picked?.item.value;
  }
}
