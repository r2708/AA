import * as vscode from 'vscode';
import type { CodePilotSettings } from '../config/configuration';

const LEVELS = { off: 0, error: 1, info: 2, debug: 3 } as const;

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private level: CodePilotSettings['logLevel'] = 'info';

  constructor() {
    this.channel = vscode.window.createOutputChannel('CodePilot');
  }

  setLevel(level: CodePilotSettings['logLevel']): void {
    this.level = level;
  }

  private write(level: keyof typeof LEVELS, message: string): void {
    if (LEVELS[level] <= LEVELS[this.level] && level !== 'off') {
      this.channel.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);
    }
  }

  info(message: string): void {
    this.write('info', message);
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  error(message: string, error?: unknown): void {
    const detail =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ''}`
        : error !== undefined
          ? String(error)
          : '';
    this.write('error', detail ? `${message}: ${detail}` : message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
