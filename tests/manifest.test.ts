import * as fs from 'fs';
import * as path from 'path';
import { assert } from './helpers/harness';
import { createRegistry, META_COMMANDS } from '../src/commands';

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    keybindings: { command: string; key: string; when?: string }[];
    configuration: { properties: Record<string, unknown> };
  };
  main: string;
  activationEvents: string[];
  engines: { vscode: string };
  publisher: string;
}

describe('extension manifest', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as Manifest;
  const registry = createRegistry();

  it('registers every command from the registry and meta commands', () => {
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const def of registry.all()) {
      assert.ok(declared.has(def.id), `missing command contribution: ${def.id}`);
    }
    for (const meta of META_COMMANDS) {
      assert.ok(declared.has(meta.id), `missing meta command: ${meta.id}`);
    }
    assert.strictEqual(declared.size, registry.all().length + META_COMMANDS.length);
  });

  it('has unique command ids and keybindings', () => {
    const ids = registry.all().map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    const keys = pkg.contributes.keybindings.map((k) => `${k.key}|${k.when ?? ''}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate keybinding');
    for (const kb of pkg.contributes.keybindings) {
      assert.ok(
        /codepilot\.enabled/.test(kb.when ?? ''),
        `${kb.command} keybinding must be gated by codepilot.enabled`,
      );
    }
  });

  it('declares the requested shortcuts', () => {
    const byCommand = new Map(pkg.contributes.keybindings.map((k) => [k.command, k.key]));
    assert.strictEqual(byCommand.get('codepilot.createFunction'), 'shift+f1');
    assert.strictEqual(byCommand.get('codepilot.createProperty'), 'shift+f12');
    assert.strictEqual(byCommand.get('codepilot.createIfElse'), 'ctrl+shift+f1');
    assert.strictEqual(byCommand.get('codepilot.createImport'), 'alt+shift+f1');
    assert.strictEqual(byCommand.get('codepilot.createReactComponent'), 'ctrl+alt+shift+f1');
    assert.strictEqual(byCommand.get('codepilot.createApiRoute'), 'ctrl+alt+f1');
    assert.strictEqual(byCommand.get('codepilot.createTest'), 'ctrl+shift+alt+f1');
    assert.strictEqual(byCommand.get('codepilot.smartAction'), 'ctrl+shift+space');
    assert.strictEqual(byCommand.get('codepilot.extractFunction'), 'ctrl+alt+shift+e');
  });

  it('declares settings and basic metadata', () => {
    const props = pkg.contributes.configuration.properties;
    for (const key of [
      'codepilot.enabled',
      'codepilot.smartMode',
      'codepilot.react.enabled',
      'codepilot.backend.enabled',
      'codepilot.testing.enabled',
      'codepilot.refactoring.enabled',
      'codepilot.formatAfterGeneration',
      'codepilot.showNotifications',
    ]) {
      assert.ok(key in props, `missing setting ${key}`);
    }
    assert.strictEqual(pkg.main, './dist/extension.js');
    assert.ok(pkg.activationEvents.length > 0);
    assert.ok(pkg.engines.vscode.startsWith('^1.'));
    assert.ok(pkg.publisher.length > 0);
  });

  it('every command has a description and a title without the CodePilot prefix', () => {
    for (const def of registry.all()) {
      assert.ok(def.description.length > 20, def.id);
      assert.ok(!def.title.startsWith('CodePilot'), def.id);
    }
  });
});
