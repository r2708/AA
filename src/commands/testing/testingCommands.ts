/**
 * Testing commands (Ctrl+Shift+Alt+F1 ... Ctrl+Shift+Alt+F12).
 * The test framework is detected from imports (vitest, @playwright/test, mocha/chai,
 * node:test) and package.json; Jest-style globals are the fallback.
 */
import * as ts from 'typescript';
import type { CodeContext, FunctionInfo, InterfaceInfo, TypeAliasInfo } from '../../types/context';
import {
  CodePilotError,
  type CommandDefinition,
  type CommandResult,
  type TextEdit,
} from '../../types/command';
import { defineCommand } from '../commandRegistry';
import {
  JS_LANGUAGES,
  canInsertStatement,
  describeSelection,
  insertStatementSnippet,
  insertTopLevelSnippet,
  no,
  ok,
  snippetAtPlan,
  statementScopeReason,
} from '../helpers';
import {
  getSelectedExpression,
  getTargetDeclaration,
  tsOf,
  unwrapExpression,
} from '../../languages/typescript/tsContext';
import { getFunctionInfo, getInterfaceInfo, isFunctionLikeNode } from '../../analyzer/astAnalyzer';
import { baseNameOf, uncapitalize, uniqueName } from '../../analyzer/naming';
import { ensureImports } from '../../transformations/importManager';
import { planTopLevelInsertion } from '../../transformations/insertion';
import {
  assertionSnippet,
  importPathForSibling,
  testCaseSnippet,
  testFileContent,
  testFilePathFor,
  testSyntaxFor,
  type TestSyntax,
} from '../../generators/testGenerator';
import { mockFactoryCode, objectLiteralForShape, shapeFromDeclaration } from '../../generators/dataGenerator';
import { escapeSnippet, renderCode, semi } from '../../generators/codeWriter';
import { sampleValueForType } from '../../analyzer/typeInference';

function syntax(ctx: CodeContext): TestSyntax {
  return testSyntaxFor(ctx.testFramework, ctx.style.quote);
}

/** Adds framework imports (vitest, node:test, playwright, chai) when the file does not already have them. */
function withFrameworkImports(ctx: CodeContext, result: CommandResult, names: string[]): CommandResult {
  const s = syntax(ctx);
  if (!s.imports.length) {
    return result;
  }
  const requests = s.imports
    .map((imp) => ({ ...imp, named: imp.named?.filter((n) => names.includes(n)) }))
    .filter((imp) => (imp.named && imp.named.length) || (imp.defaultName && names.includes(imp.defaultName)));
  if (!requests.length) {
    return result;
  }
  const resolution = ensureImports(ctx, requests);
  return { ...result, edits: [...(result.edits ?? []), ...resolution.edits] };
}

function functionAtCursor(ctx: CodeContext): FunctionInfo | undefined {
  const ast = tsOf(ctx);
  const decl = getTargetDeclaration(ctx);
  if (decl && ts.isFunctionDeclaration(decl)) {
    return getFunctionInfo(decl, ast.sourceFile);
  }
  if (decl && ts.isVariableStatement(decl)) {
    const init = decl.declarationList.declarations[0]?.initializer;
    if (init && isFunctionLikeNode(init)) {
      return getFunctionInfo(init, ast.sourceFile);
    }
  }
  if (ctx.selection.kind === 'none' && ast.enclosingFunctionNode) {
    // Innermost function is usually a callback; prefer the outermost named function.
    let node: ts.Node | undefined = ast.enclosingFunctionNode;
    let best: FunctionInfo | undefined;
    while (node) {
      if (isFunctionLikeNode(node)) {
        const info = getFunctionInfo(node, ast.sourceFile);
        if (info.name && !/^(describe|it|test)$/.test(info.name)) {
          best = info;
        }
      }
      node = node.parent;
    }
    return best;
  }
  return undefined;
}

function testableFunctions(ctx: CodeContext): FunctionInfo[] {
  const exported = ctx.declarations.functions.filter(
    (f) => f.isExported && f.name && !/^use[A-Z]/.test(f.name),
  );
  if (exported.length) {
    return exported;
  }
  return ctx.declarations.functions.filter((f) => f.name);
}

function testingApplicabilityBase(ctx: CodeContext) {
  if (ctx.selection.kind !== 'none') {
    return no('Clear the selection to insert test code.');
  }
  if (!canInsertStatement(ctx)) {
    return no(statementScopeReason(ctx));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// F1 Test / F2 Test Suite
// ---------------------------------------------------------------------------

export const createTest: CommandDefinition = defineCommand({
  id: 'codepilot.createTest',
  title: 'Create Test',
  category: 'testing',
  description:
    'Inserts a test case using the detected framework; inside a describe block for a known function it pre-fills the call with sample arguments.',
  keybinding: { key: 'ctrl+shift+alt+f1' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const base = testingApplicabilityBase(ctx);
    if (base) {
      return base;
    }
    if (!ctx.isTestFile) {
      return no('This is not a test file. Use Generate Test to create one for the current function.');
    }
    return ok(60, `Insert a ${ctx.testFramework} test case`);
  },
  async execute(ctx) {
    const s = syntax(ctx);
    const sc = semi(ctx);
    const q = ctx.style.quote;
    // Inside `describe('name', ...)`: use the described function when it exists in the imports.
    const ast = tsOf(ctx);
    let describedName: string | undefined;
    let node: ts.Node | undefined = ast.nodeAtCursor;
    while (node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'describe' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        describedName = node.arguments[0].text;
        break;
      }
      node = node.parent;
    }
    const imported = describedName
      ? ctx.declarations.imports
          .flatMap((i) => i.namedImports.map((n) => n.alias ?? n.name))
          .find((n) => n === describedName)
      : undefined;
    if (imported) {
      const fn: FunctionInfo = {
        name: imported,
        kind: 'function',
        range: { start: 0, end: 0 },
        isExported: true,
        parameters: [],
        isAsync: false,
        isGenerator: false,
        isArrow: false,
        hasExpressionBody: false,
      };
      return withFrameworkImports(ctx, insertStatementSnippet(ctx, testCaseSnippet(ctx, fn, s)), [
        'it',
        'test',
        'expect',
        'assert',
      ]);
    }
    const template = `${s.it}(${q}\${1:does something}${q}, \${2:async }() => {\n\t$0\n\t${assertionSnippet(s, '${3:actual}', '${4:expected}', sc)}\n})${sc}`;
    return withFrameworkImports(ctx, insertStatementSnippet(ctx, template), [
      'it',
      'test',
      'expect',
      'assert',
    ]);
  },
});

export const createTestSuite: CommandDefinition = defineCommand({
  id: 'codepilot.createTestSuite',
  title: 'Create Test Suite',
  category: 'testing',
  description:
    'Inserts a describe block named after the module under test (from the file name or the first relative import).',
  keybinding: { key: 'ctrl+shift+alt+f2' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const base = testingApplicabilityBase(ctx);
    if (base) {
      return base;
    }
    return ok(ctx.isTestFile ? 50 : 15, `Insert a ${ctx.testFramework} describe block`);
  },
  async execute(ctx) {
    const s = syntax(ctx);
    const sc = semi(ctx);
    const q = ctx.style.quote;
    const relativeImport = ctx.declarations.imports.find((i) => i.moduleSpecifier.startsWith('.'));
    const subject =
      relativeImport?.namedImports[0]?.name ??
      relativeImport?.defaultImport ??
      baseNameOf(ctx.snapshot.fileName).replace(/\.(test|spec)$/, '');
    const template = `${s.describe}(${q}\${1:${escapeSnippet(subject)}}${q}, () => {\n\t${s.it}(${q}\${2:does something}${q}, () => {\n\t\t$0\n\t})${sc}\n})${sc}`;
    return withFrameworkImports(ctx, insertStatementSnippet(ctx, template), ['describe', 'test', 'it']);
  },
});

// ---------------------------------------------------------------------------
// F3 Assertion / F4 Mock / F5 Spy
// ---------------------------------------------------------------------------

export const createAssertion: CommandDefinition = defineCommand({
  id: 'codepilot.createAssertion',
  title: 'Create Assertion',
  category: 'testing',
  description:
    'Inserts an assertion in the detected framework style (expect/chai/node:assert), using the selected expression as the actual value.',
  keybinding: { key: 'ctrl+shift+alt+f3' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      return ok(ctx.isTestFile ? 65 : 30, `Assert on ${describeSelection(ctx)}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select the expression to assert on.');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(ctx.isTestFile ? 40 : 10, 'Insert an assertion');
  },
  async execute(ctx) {
    const s = syntax(ctx);
    const sc = semi(ctx);
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const text = escapeSnippet(ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end));
      const stmt = expr.parent && ts.isExpressionStatement(expr.parent) ? expr.parent : undefined;
      const template = assertionSnippet(s, text, '${1:expected}', sc);
      if (stmt) {
        const ast = tsOf(ctx);
        return withFrameworkImports(
          ctx,
          {
            snippet: { range: { start: stmt.getStart(ast.sourceFile), end: stmt.getEnd() }, body: template },
          },
          ['expect', 'assert'],
        );
      }
      return withFrameworkImports(
        ctx,
        { snippet: { range: ctx.selection.range, body: template.replace(new RegExp(`${sc}$`), '') } },
        ['expect', 'assert'],
      );
    }
    const actual = ctx.scope.visibleNames.has('result') ? 'result' : '${1:actual}';
    return withFrameworkImports(
      ctx,
      insertStatementSnippet(ctx, assertionSnippet(s, actual, '${2:expected}', sc)),
      ['expect', 'assert'],
    );
  },
});

export const createMock: CommandDefinition = defineCommand({
  id: 'codepilot.createMock',
  title: 'Create Mock',
  category: 'testing',
  description:
    'Mocks the module of the import at the cursor, creates a mock function for a selected identifier, or inserts a module mock.',
  keybinding: { key: 'ctrl+shift+alt+f4' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isImportDeclaration(decl)) {
      return ok(70, `Mock module ${(decl.moduleSpecifier as ts.StringLiteral).text}`);
    }
    if (ctx.selection.kind === 'identifier') {
      return ok(50, `Create a mock function for ${ctx.selection.text}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an identifier or place the cursor on an import.');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(ctx.isTestFile ? 30 : 10, 'Insert a module mock');
  },
  async execute(ctx) {
    const s = syntax(ctx);
    const sc = semi(ctx);
    const q = ctx.style.quote;
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isImportDeclaration(decl)) {
      const module = (decl.moduleSpecifier as ts.StringLiteral).text;
      const plan = planTopLevelInsertion(ctx, { afterImports: true });
      return withFrameworkImports(ctx, snippetAtPlan(ctx, plan, `${s.mockModule(module)}${sc}`), [
        'vi',
        'mock',
      ]);
    }
    if (ctx.selection.kind === 'identifier') {
      const name = uniqueName(`${ctx.selection.text}Mock`, ctx.scope.visibleNames);
      const stmt = tsOf(ctx).selectedStatements[0];
      if (stmt) {
        const ast = tsOf(ctx);
        return withFrameworkImports(
          ctx,
          {
            snippet: {
              range: { start: stmt.getStart(ast.sourceFile), end: stmt.getEnd() },
              body: `const ${name} = ${s.mockFn()}${sc}`,
            },
          },
          ['vi', 'mock'],
        );
      }
      return withFrameworkImports(ctx, insertStatementSnippet(ctx, `const ${name} = ${s.mockFn()}${sc}`), [
        'vi',
        'mock',
      ]);
    }
    return withFrameworkImports(
      ctx,
      insertStatementSnippet(
        ctx,
        `${s.mockModule(`\${1:./module}`).replace(new RegExp(`${q}\\$\\{1:./module\\}${q}`), `${q}\${1:./module}${q}`)}${sc}`,
      ),
      ['vi', 'mock'],
    );
  },
});

export const createSpy: CommandDefinition = defineCommand({
  id: 'codepilot.createSpy',
  title: 'Create Spy',
  category: 'testing',
  description: 'Creates a spy on the selected `object.method`, or inserts a spy skeleton.',
  keybinding: { key: 'ctrl+shift+alt+f5' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr && ts.isPropertyAccessExpression(unwrapExpression(expr))) {
      return ok(65, `Spy on ${describeSelection(ctx)}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an `object.method` expression to spy on.');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(ctx.isTestFile ? 25 : 10, 'Insert a spy');
  },
  async execute(ctx) {
    const s = syntax(ctx);
    const sc = semi(ctx);
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr && ts.isPropertyAccessExpression(unwrapExpression(expr))) {
      const access = unwrapExpression(expr) as ts.PropertyAccessExpression;
      const sf = tsOf(ctx).sourceFile;
      const target = access.expression.getText(sf);
      const method = access.name.text;
      const name = uniqueName(`${method}Spy`, ctx.scope.visibleNames);
      const code = `const ${name} = ${s.spyOn(target, method)}${sc}`;
      const stmt = expr.parent && ts.isExpressionStatement(expr.parent) ? expr.parent : undefined;
      if (stmt) {
        return withFrameworkImports(
          ctx,
          { snippet: { range: { start: stmt.getStart(sf), end: stmt.getEnd() }, body: escapeSnippet(code) } },
          ['vi', 'mock'],
        );
      }
      return withFrameworkImports(ctx, insertStatementSnippet(ctx, escapeSnippet(code)), ['vi', 'mock']);
    }
    return withFrameworkImports(
      ctx,
      insertStatementSnippet(ctx, `const \${1:spy} = ${s.spyOn('${2:object}', '${3:method}')}${sc}`),
      ['vi', 'mock'],
    );
  },
});

// ---------------------------------------------------------------------------
// F6..F9 lifecycle hooks
// ---------------------------------------------------------------------------

function lifecycleCommand(
  id: string,
  title: string,
  key: string,
  hook: 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll',
): CommandDefinition {
  return defineCommand({
    id,
    title,
    category: 'testing',
    description: `Inserts a ${hook} block in the detected framework style.`,
    keybinding: { key },
    supportedLanguages: JS_LANGUAGES,
    canExecute(ctx) {
      const base = testingApplicabilityBase(ctx);
      if (base) {
        return base;
      }
      return ok(ctx.isTestFile ? 35 : 10, `Insert ${hook}`);
    },
    async execute(ctx) {
      const s = syntax(ctx);
      const sc = semi(ctx);
      const name = s[hook];
      return withFrameworkImports(
        ctx,
        insertStatementSnippet(ctx, `${name}(\${1:async }() => {\n\t$0\n})${sc}`),
        [name.replace(/^test\./, ''), 'before', 'after'],
      );
    },
  });
}

export const createBeforeEach = lifecycleCommand(
  'codepilot.createBeforeEach',
  'Create beforeEach',
  'ctrl+shift+alt+f6',
  'beforeEach',
);
export const createAfterEach = lifecycleCommand(
  'codepilot.createAfterEach',
  'Create afterEach',
  'ctrl+shift+alt+f7',
  'afterEach',
);
export const createBeforeAll = lifecycleCommand(
  'codepilot.createBeforeAll',
  'Create beforeAll',
  'ctrl+shift+alt+f8',
  'beforeAll',
);
export const createAfterAll = lifecycleCommand(
  'codepilot.createAfterAll',
  'Create afterAll',
  'ctrl+shift+alt+f9',
  'afterAll',
);

// ---------------------------------------------------------------------------
// F10 Generate Test
// ---------------------------------------------------------------------------

export const generateTest: CommandDefinition = defineCommand({
  id: 'codepilot.generateTest',
  title: 'Generate Test',
  category: 'testing',
  description:
    'Generates a test skeleton for the function at the cursor (or all exported functions) in a sibling test file, with calls pre-filled from the signature.',
  keybinding: { key: 'ctrl+shift+alt+f10' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (ctx.isTestFile) {
      const fn = functionAtCursor(ctx);
      if (fn && !/^(describe|it|test)$/.test(fn.name)) {
        return ok(40, `Insert a test case for ${fn.name}`);
      }
      return no('Place the cursor in a source file to generate a test file for it.');
    }
    const fn = functionAtCursor(ctx);
    if (fn?.name) {
      return ok(
        75,
        `Generate ${testFilePathFor(baseNameOf(ctx.snapshot.fileName) + '.ts', ctx.testFramework).replace(/\.ts$/, '')} with a test for ${fn.name}()`,
      );
    }
    const fns = testableFunctions(ctx);
    if (fns.length) {
      return ok(
        45,
        `Generate tests for ${fns.length} function${fns.length === 1 ? '' : 's'} in a sibling test file`,
      );
    }
    return no('No functions found to test in this file.');
  },
  async execute(ctx) {
    const s = syntax(ctx);
    const fn = functionAtCursor(ctx);
    if (ctx.isTestFile) {
      if (!fn) {
        throw new CodePilotError(
          'unavailable',
          'Place the cursor in a source file to generate a test file for it.',
        );
      }
      return withFrameworkImports(ctx, insertStatementSnippet(ctx, testCaseSnippet(ctx, fn, s)), [
        'it',
        'test',
        'expect',
        'assert',
      ]);
    }
    const targets = fn?.name ? [fn] : testableFunctions(ctx);
    if (!targets.length) {
      throw new CodePilotError('unavailable', 'No functions found to test in this file.');
    }
    const testPath = testFilePathFor(ctx.snapshot.fileName, ctx.testFramework);
    const content = renderCode(
      testFileContent(ctx, targets, importPathForSibling(ctx.snapshot.fileName), s),
      ctx,
    );
    const notExported = targets.filter((t) => !t.isExported).map((t) => t.name);
    const warning = notExported.length
      ? ` Note: ${notExported.join(', ')} ${notExported.length === 1 ? 'is' : 'are'} not exported yet.`
      : '';
    return {
      newFile: { path: testPath, content, open: true },
      message: `Generated ${targets.length} test${targets.length === 1 ? '' : 's'} (${ctx.testFramework}) in ${baseNameOf(testPath)}.${warning}`,
    };
  },
});

// ---------------------------------------------------------------------------
// F11 Generate Test Data / F12 Generate Mock Data
// ---------------------------------------------------------------------------

function shapeTarget(ctx: CodeContext): InterfaceInfo | TypeAliasInfo | undefined {
  const ast = tsOf(ctx);
  const decl = getTargetDeclaration(ctx);
  if (decl && ts.isInterfaceDeclaration(decl)) {
    return getInterfaceInfo(decl, ast.sourceFile);
  }
  if (decl && ts.isTypeAliasDeclaration(decl)) {
    return ctx.declarations.types.find((t) => t.name === decl.name.text && t.members);
  }
  if (ctx.selection.kind === 'identifier') {
    const name = ctx.selection.text;
    return (
      ctx.declarations.interfaces.find((i) => i.name === name) ??
      ctx.declarations.types.find((t) => t.name === name && t.members)
    );
  }
  // Type referenced by an import (test files): use the first imported PascalCase type declared... unknown here.
  return undefined;
}

export const generateTestData: CommandDefinition = defineCommand({
  id: 'codepilot.generateTestData',
  title: 'Generate Test Data',
  category: 'testing',
  description:
    'Creates a sample object for the interface/type at the cursor (or sample arguments for the function at the cursor).',
  keybinding: { key: 'ctrl+shift+alt+f11' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const target = shapeTarget(ctx);
    if (target && shapeFromDeclaration(target)) {
      return ok(65, `Create sample data for ${target.name}`);
    }
    const fn = functionAtCursor(ctx);
    if (fn && fn.parameters.length) {
      return ok(45, `Create sample arguments for ${fn.name}(${fn.parameters.map((p) => p.name).join(', ')})`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an interface, type or function.');
    }
    return no('Place the cursor on an interface, type or function with parameters.');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const target = shapeTarget(ctx);
    const shape = target ? shapeFromDeclaration(target) : undefined;
    if (target && shape) {
      const varName = uniqueName(
        `${uncapitalize(target.name)}Data`,
        new Set([...ctx.scope.visibleNames, ...ctx.declarations.topLevelNames]),
      );
      const annotation = ctx.language.isTypeScript ? `: ${target.name}` : '';
      const code = `const \${1:${varName}}${annotation} = ${escapeSnippet(objectLiteralForShape(ctx, shape, true))}${sc}`;
      const decl = getTargetDeclaration(ctx);
      if (decl) {
        const end = decl.getEnd();
        const rest = ctx.text.slice(end);
        return snippetAtPlan(
          ctx,
          {
            range: { start: end, end },
            indent: '',
            prefix: ctx.eol + ctx.eol,
            suffix: rest.trim().length === 0 || /^\r?\n\s*\r?\n/.test(rest) ? '' : ctx.eol,
          },
          code,
          { message: `Created ${varName} with ${shape.members.length} properties` },
        );
      }
      return canInsertStatement(ctx)
        ? insertStatementSnippet(ctx, code)
        : insertTopLevelSnippet(ctx, code, { position: 'after' });
    }
    const fn = functionAtCursor(ctx);
    if (fn && fn.parameters.length) {
      const q = ctx.style.quote;
      const lines = fn.parameters
        .filter((p) => !p.isRest)
        .map((p) => `\t${p.name}: ${sampleValueForType(p.typeText, p.name, q)},`);
      const code = `const \${1:${escapeSnippet(fn.name)}Args} = {\n${escapeSnippet(lines.join('\n'))}\n}${sc}`;
      if (ctx.isTestFile && canInsertStatement(ctx)) {
        return insertStatementSnippet(ctx, code);
      }
      return insertTopLevelSnippet(ctx, code, { position: 'after' });
    }
    throw new CodePilotError(
      'unavailable',
      'Place the cursor on an interface, type or function with parameters.',
    );
  },
});

export const generateMockData: CommandDefinition = defineCommand({
  id: 'codepilot.generateMockData',
  title: 'Generate Mock Data',
  category: 'testing',
  description:
    'Creates a `createMockX(overrides)` factory for the interface/type at the cursor with sensible defaults per property.',
  keybinding: { key: 'ctrl+shift+alt+f12' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const target = shapeTarget(ctx);
    if (target && shapeFromDeclaration(target)) {
      if (ctx.declarations.topLevelNames.has(`createMock${target.name}`)) {
        return no(`createMock${target.name} already exists.`);
      }
      return ok(60, `Create a createMock${target.name}() factory`);
    }
    return no('Place the cursor on an interface or object type.');
  },
  async execute(ctx) {
    const target = shapeTarget(ctx);
    const shape = target ? shapeFromDeclaration(target) : undefined;
    if (!target || !shape) {
      throw new CodePilotError('unavailable', 'Place the cursor on an interface or object type.');
    }
    const code = mockFactoryCode(ctx, shape);
    const decl = getTargetDeclaration(ctx);
    const edits: TextEdit[] = [];
    if (decl) {
      const end = decl.getEnd();
      const rest = ctx.text.slice(end);
      const suffix = rest.trim().length === 0 || /^\r?\n\s*\r?\n/.test(rest) ? '' : ctx.eol;
      edits.push({
        range: { start: end, end },
        text:
          ctx.eol +
          ctx.eol +
          code
            .split('\n')
            .map((l) => l.replace(/^\t+/, (t) => ctx.indent.unit.repeat(t.length)))
            .join(ctx.eol) +
          suffix,
      });
    } else {
      const plan = planTopLevelInsertion(ctx, { position: 'after' });
      edits.push({
        range: plan.range,
        text:
          plan.prefix +
          code
            .split('\n')
            .map((l) => l.replace(/^\t+/, (t) => ctx.indent.unit.repeat(t.length)))
            .join(ctx.eol) +
          plan.suffix,
      });
    }
    return { edits, message: `Created createMock${target.name}() with ${shape.members.length} defaults` };
  },
});

export const testingCommands: CommandDefinition[] = [
  createTest,
  createTestSuite,
  createAssertion,
  createMock,
  createSpy,
  createBeforeEach,
  createAfterEach,
  createBeforeAll,
  createAfterAll,
  generateTest,
  generateTestData,
  generateMockData,
];
