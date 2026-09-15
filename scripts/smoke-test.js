// Loads the bundled extension against a minimal `vscode` mock and checks that every
// command contributed in package.json gets a handler when activate() runs.
const Module = require('module');
const path = require('path');

const registered = new Set();
const contextKeys = {};

const vscodeMock = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '' }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showWarningMessage: () => undefined,
    showInformationMessage: () => undefined,
    showErrorMessage: () => Promise.resolve(undefined),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d, update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    getWorkspaceFolder: () => undefined,
  },
  commands: {
    registerCommand: (id) => {
      registered.add(id);
      return { dispose() {} };
    },
    executeCommand: async (cmd, key, value) => {
      if (cmd === 'setContext') {
        contextKeys[key] = value;
      }
    },
  },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {},
  Disposable: class {
    constructor(fn) {
      this.fn = fn;
    }
    dispose() {
      this.fn();
    }
  },
  ConfigurationTarget: { Global: 1 },
  EndOfLine: { LF: 1, CRLF: 2 },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, request, ...rest);
};

const bundlePath = path.join(__dirname, '..', 'dist', 'extension.js');
const extension = require(bundlePath);
const api = extension.activate({ subscriptions: [] });

const pkg = require('../package.json');
const contributed = pkg.contributes.commands.map((c) => c.command);
const missing = contributed.filter((id) => !registered.has(id));
const extra = [...registered].filter((id) => !contributed.includes(id));

if (missing.length || extra.length) {
  console.error('Command registration mismatch.', { missing, extra });
  process.exit(1);
}
if (
  !Array.isArray(contextKeys['codepilot.supportedLanguages']) ||
  contextKeys['codepilot.enabled'] !== true
) {
  console.error('Context keys not set', contextKeys);
  process.exit(1);
}
for (const fn of ['registerAIProvider', 'registerLanguageAdapter', 'registerCommand']) {
  if (typeof api[fn] !== 'function') {
    console.error(`API is missing ${fn}`);
    process.exit(1);
  }
}
console.log(
  `Smoke test passed: ${registered.size} commands registered from the bundle, context keys set, API exported.`,
);
