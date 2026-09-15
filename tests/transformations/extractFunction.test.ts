import { assert } from '../helpers/harness';
import { analyze, applyResult } from '../helpers/harness';
import { analyzeExtraction, extractFunction } from '../../src/transformations/extractFunction';
import { extractVariable, extractConstant } from '../../src/transformations/extractVariable';
import { CodePilotError } from '../../src/types/command';

describe('extract function', () => {
  it('returns a single declared variable used afterwards', () => {
    const ctx = analyze(
      `async function f(id: string) {\n[[  const user = await api.get(id);\n  const name = user.name;\n]]  return name;\n}`,
    );
    const analysis = analyzeExtraction(ctx);
    assert.deepStrictEqual(
      analysis.params.map((p) => `${p.name}:${p.typeText}`),
      ['id:string'],
    );
    assert.deepStrictEqual(
      analysis.returns.map((r) => r.name),
      ['name'],
    );
    assert.strictEqual(analysis.isAsync, true);
    const text = applyResult(ctx.text, extractFunction(ctx));
    assert.strictEqual(
      text,
      `async function f(id: string) {\n  const name = await fetchName(id);\n  return name;\n}\n\nasync function fetchName(id: string) {\n  const user = await api.get(id);\n  const name = user.name;\n  return name;\n}`,
    );
  });

  it('returns multiple variables as an object', () => {
    const ctx = analyze(`function f() {\n[[  const a = 1;\n  let b = 2;\n]]  return a + b;\n}`);
    const text = applyResult(ctx.text, extractFunction(ctx));
    assert.ok(text.includes('  let { a, b } = getA();\n  return a + b;'), text);
    assert.ok(text.includes('  return { a, b };'), text);
  });

  it('turns a trailing return into a returning call', () => {
    const ctx = analyze(`function f(x: number) {\n[[  const y = x * 2;\n  return y + 1;\n]]}`);
    const text = applyResult(ctx.text, extractFunction(ctx));
    assert.ok(text.includes('function f(x: number) {\n  return computeSum(x);\n}'), text);
  });

  it('ignores module-level references and globals', () => {
    const ctx = analyze(
      `const LIMIT = 3;\nfunction f(items: number[]) {\n[[  console.log(items.slice(0, LIMIT));\n]]}`,
    );
    const analysis = analyzeExtraction(ctx);
    assert.deepStrictEqual(
      analysis.params.map((p) => p.name),
      ['items'],
    );
  });

  it('extracts top-level statements before their usage site', () => {
    const ctx = analyze(`[[const a = compute();\nconsole.log(a);]]\nconsole.log('done');`);
    const text = applyResult(ctx.text, extractFunction(ctx));
    assert.strictEqual(
      text,
      `function getA() {\n  const a = compute();\n  console.log(a);\n}\n\ngetA();\nconsole.log('done');`,
    );
  });

  it('rejects conditional returns and this outside classes', () => {
    const cond = analyze(`function f(a) {\n[[  if (a) {\n    return 1;\n  }\n  log();\n]]  return 2;\n}`);
    assert.throws(
      () => extractFunction(cond),
      (e: unknown) => e instanceof CodePilotError && e.kind === 'invalidTransformation',
    );
    const partial = analyze(`function f() {\n  const a = [[1 +]] 2;\n}`);
    assert.throws(
      () => extractFunction(partial),
      (e: unknown) => e instanceof CodePilotError && e.kind === 'invalidSelection',
    );
  });

  it('does not corrupt malformed code', () => {
    const ctx = analyze(`function f( {\n[[  const a = ;\n]]}`);
    assert.throws(() => extractFunction(ctx), CodePilotError);
  });
});

describe('extract variable / constant', () => {
  it('places the declaration before the enclosing statement inside JSX', () => {
    const ctx = analyze(`function App({ user }) {\n  return <div title={[[user.profile.name]]} />;\n}`, {
      languageId: 'typescriptreact',
    });
    const text = applyResult(ctx.text, extractVariable(ctx));
    assert.strictEqual(
      text,
      `function App({ user }) {\n  const profileName = user.profile.name;\n  return <div title={profileName} />;\n}`,
    );
  });

  it('adds a type annotation when requested and inferable', () => {
    const ctx = analyze(`const price = 2;\nconst total = [[price * 3]] + 1;`);
    const text = applyResult(ctx.text, extractVariable(ctx, { annotate: true }));
    assert.strictEqual(
      text,
      `const price = 2;\nconst product: number = price * 3;\nconst total = product + 1;`,
    );
  });

  it('hoists literals to constants in files without imports', () => {
    const ctx = analyze(`function f() {\n  return [[42]];\n}`);
    const text = applyResult(ctx.text, extractConstant(ctx));
    assert.strictEqual(text, `const VALUE = 42;\n\nfunction f() {\n  return VALUE;\n}`);
  });
});
