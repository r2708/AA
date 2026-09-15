import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ProjectInfo } from '../types/context';
import { analyzePackageJson, emptyProjectInfo } from '../analyzer/projectDetector';

interface CacheEntry {
  info: ProjectInfo;
  time: number;
}

const TTL_MS = 60_000;

/**
 * Finds the nearest package.json above a file (bounded by the workspace folder) and caches
 * the analysed result per directory. No project-wide scans, no work on keystrokes.
 */
export class ProjectInfoProvider implements vscode.Disposable {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (path.basename(doc.fileName) === 'package.json') {
          this.cache.clear();
        }
      }),
    );
  }

  forDocument(document: vscode.TextDocument): ProjectInfo {
    if (document.uri.scheme !== 'file') {
      return emptyProjectInfo();
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const root = folder?.uri.fsPath;
    let dir = path.dirname(document.uri.fsPath);
    const visited: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const cached = this.cache.get(dir);
      if (cached && Date.now() - cached.time < TTL_MS) {
        visited.forEach((d) => this.cache.set(d, cached));
        return cached.info;
      }
      visited.push(dir);
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        let text: string | undefined;
        try {
          text = fs.readFileSync(candidate, 'utf8');
        } catch {
          text = undefined;
        }
        const info = analyzePackageJson(text, dir);
        const entry = { info, time: Date.now() };
        visited.forEach((d) => this.cache.set(d, entry));
        return info;
      }
      if (root && (dir === root || !dir.startsWith(root))) {
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    const entry = { info: emptyProjectInfo(), time: Date.now() };
    visited.forEach((d) => this.cache.set(d, entry));
    return entry.info;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
