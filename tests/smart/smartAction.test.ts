import { assert, analyze, applyResult, ScriptedUI } from '../helpers/harness';
import { createRegistry } from '../../src/commands';
import { rankActions } from '../../src/smart/actionScorer';
import { runSmartAction, smartActions } from '../../src/smart/smartAction';

const registry = createRegistry();

describe('Smart Action', () => {
  it('ranks extraction and error handling first for awaited selections', () => {
    const ctx = analyze(
      `async function load(url: string) {\n[[  const response = await fetch(url);\n  const data = await response.json();\n]]  return data;\n}`,
    );
    const actions = smartActions(registry, ctx);
    const ids = actions.map((a) => a.command.id);
    assert.ok(ids.indexOf('codepilot.extractFunction') < 3, ids.join(','));
    assert.ok(ids.includes('codepilot.createTryCatch'), ids.join(','));
    assert.ok(!ids.includes('codepilot.createUseState'));
    assert.ok(!ids.includes('codepilot.createReactComponent'));
    assert.ok(actions.length <= 8);
    assert.ok(actions.every((a) => a.detail.length > 0));
  });

  it('prefers interface inference for object literal selections', () => {
    const ctx = analyze(`const user = [[{ id: 1, name: 'John', active: true }]];`);
    const [first] = smartActions(registry, ctx);
    assert.strictEqual(first.command.id, 'codepilot.createInterface');
  });

  it('offers constructor and property actions inside a class body', () => {
    const ctx = analyze(`class User {\n  id: string;\n  <|>\n}`);
    const ids = smartActions(registry, ctx).map((a) => a.command.id);
    assert.ok(ids.includes('codepilot.createConstructor'));
    assert.ok(ids.includes('codepilot.createProperty'));
    assert.ok(!ids.includes('codepilot.createTryCatch'));
  });

  it('boosts testing commands in test files and hides React ones outside React', () => {
    const ctx = analyze(`describe('x', () => {\n  <|>\n});`, { fileName: '/p/a.test.ts' });
    const ids = smartActions(registry, ctx).map((a) => a.command.id);
    assert.strictEqual(ids[0], 'codepilot.createTest');
    assert.ok(!ids.some((id) => id.includes('React') || id.includes('useState')));
  });

  it('scores React commands inside components', () => {
    const ctx = analyze(`import { useState } from 'react';\nfunction App() {\n  <|>\n  return <div />;\n}`, {
      languageId: 'typescriptreact',
    });
    const ids = smartActions(registry, ctx).map((a) => a.command.id);
    assert.ok(ids.includes('codepilot.createUseState'), ids.join(','));
  });

  it('falls back gracefully when little applies', () => {
    const ctx = analyze(`function App() { return <div><|></div>; }`, { languageId: 'typescriptreact' });
    const ranked = rankActions(registry.available(ctx), ctx);
    assert.ok(ranked.length > 0 && ranked.length <= 8);
  });

  it('executes the picked action', async () => {
    const ctx = analyze(`const n = [[a || b]];`);
    const ui = new ScriptedUI(['Nullish']);
    const result = await runSmartAction(registry, ctx, ui);
    assert.strictEqual(applyResult(ctx.text, result), `const n = a ?? b;`);
    const cancelled = await runSmartAction(registry, ctx, new ScriptedUI([undefined]));
    assert.strictEqual(cancelled.cancelled, true);
  });
});
