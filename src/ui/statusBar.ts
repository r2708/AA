import * as vscode from 'vscode';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('codepilot.status', vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'CodePilot';
    this.item.command = 'codepilot.statusMenu';
    this.item.show();
  }

  update(enabled: boolean, supportedFile: boolean): void {
    if (!enabled) {
      this.item.text = '$(circle-slash) CodePilot: OFF';
      this.item.tooltip = 'CodePilot is disabled. Click for options.';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    this.item.backgroundColor = undefined;
    this.item.text = supportedFile ? '$(rocket) CodePilot: ON' : '$(rocket) CodePilot';
    this.item.tooltip = supportedFile
      ? 'CodePilot is active for this file. Ctrl+Shift+Space for Smart Action. Click for options.'
      : 'CodePilot supports JavaScript, TypeScript, JSX and TSX files. Click for options.';
  }

  /** Briefly shows a busy indicator while a command runs. */
  busy(label: string): () => void {
    const previous = this.item.text;
    this.item.text = `$(sync~spin) ${label}`;
    return () => {
      this.item.text = previous;
    };
  }

  dispose(): void {
    this.item.dispose();
  }
}
