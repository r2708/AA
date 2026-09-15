// Regenerates package.json `contributes` (commands, keybindings, menus, configuration)
// from the command registry so the manifest can never drift from the code.
const fs = require('fs');
const path = require('path');

const { createRegistry, META_COMMANDS } = require('../out/src/commands');
const { SETTINGS_SCHEMA } = require('../out/src/config/configuration');

const EDITOR_WHEN =
  'editorTextFocus && !editorReadonly && codepilot.enabled && editorLangId in codepilot.supportedLanguages';
const PALETTE_WHEN = 'editorLangId in codepilot.supportedLanguages';

function build() {
  const registry = createRegistry();
  const commands = [];
  const keybindings = [];
  const palette = [];

  for (const def of registry.all()) {
    commands.push({
      command: def.id,
      title: def.title,
      category: 'CodePilot',
      enablement: 'codepilot.enabled',
    });
    palette.push({ command: def.id, when: PALETTE_WHEN });
    if (def.keybinding) {
      const binding = {
        command: def.id,
        key: def.keybinding.key,
        when: def.keybinding.when ? `${EDITOR_WHEN} && ${def.keybinding.when}` : EDITOR_WHEN,
      };
      if (def.keybinding.mac) {
        binding.mac = def.keybinding.mac;
      }
      keybindings.push(binding);
    }
  }
  for (const meta of META_COMMANDS) {
    commands.push({ command: meta.id, title: meta.title, category: 'CodePilot' });
    if (meta.paletteWhen) {
      palette.push({ command: meta.id, when: meta.paletteWhen });
    }
    if (meta.keybinding) {
      keybindings.push({
        command: meta.id,
        key: meta.keybinding.key,
        when: meta.keybinding.when ?? EDITOR_WHEN,
      });
    }
  }

  const properties = {};
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    properties[key] = { ...schema };
  }

  return {
    commands,
    keybindings,
    menus: { commandPalette: palette },
    configuration: { title: 'CodePilot', properties },
  };
}

function main() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const contributes = build();
  const check = process.argv.includes('--check');
  const next = { ...pkg, contributes };
  const serialized = JSON.stringify(next, null, 2) + '\n';
  const current = fs.readFileSync(pkgPath, 'utf8');
  if (check) {
    if (serialized !== current) {
      console.error('package.json contributes are out of date. Run `npm run sync-manifest`.');
      process.exit(1);
    }
    console.log('package.json contributes are in sync.');
    return;
  }
  fs.writeFileSync(pkgPath, serialized);
  console.log(
    `package.json updated: ${contributes.commands.length} commands, ${contributes.keybindings.length} keybindings, ${Object.keys(contributes.configuration.properties).length} settings.`,
  );
}

main();
