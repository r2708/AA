/**
 * Import / export and expression-level commands (Alt+Shift+F1 ... Alt+Shift+F12).
 */
import * as ts from 'typescript';
import type { CodeContext } from '../../types/context';
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
  lineIndentAt,
} from '../../languages/typescript/tsContext';
import {
  collectValueReferences,
  getEnclosingFunction,
  isExported,
  type FunctionLikeNode,
} from '../../analyzer/astAnalyzer';
import { checkerTypeText } from '../../analyzer/typeInference';
import { ensureImports, isImported } from '../../transformations/importManager';
import {
  planImportInsertion,
  planStatementInsertion,
  planAfterImports,
} from '../../transformations/insertion';
import { orToNullish, thenToAwait, toOptionalChain } from '../../transformations/convert';
import { escapeSnippet, renderCode, semi } from '../../generators/codeWriter';
import { wrapStatements } from '../../transformations/wrap';

// ---------------------------------------------------------------------------
// Known symbols → module (only used when the module is a dependency, React or a Node builtin)
// ---------------------------------------------------------------------------

interface KnownSymbol {
  module: string;
  kind: 'named' | 'default';
  /** Only offer when this dependency exists (undefined = always). */
  requires?: string;
}

const REACT_HOOKS = [
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
  'useContext',
  'useReducer',
  'useLayoutEffect',
  'useId',
  'useTransition',
  'useDeferredValue',
  'createContext',
  'forwardRef',
  'memo',
  'lazy',
  'Suspense',
  'Fragment',
  'StrictMode',
];

const KNOWN_SYMBOLS: Record<string, KnownSymbol> = {
  React: { module: 'react', kind: 'default' },
  ...Object.fromEntries(REACT_HOOKS.map((h) => [h, { module: 'react', kind: 'named' } as KnownSymbol])),
  readFile: { module: 'node:fs/promises', kind: 'named' },
  writeFile: { module: 'node:fs/promises', kind: 'named' },
  readFileSync: { module: 'node:fs', kind: 'named' },
  writeFileSync: { module: 'node:fs', kind: 'named' },
  existsSync: { module: 'node:fs', kind: 'named' },
  mkdirSync: { module: 'node:fs', kind: 'named' },
  join: { module: 'node:path', kind: 'named' },
  resolve: { module: 'node:path', kind: 'named' },
  dirname: { module: 'node:path', kind: 'named' },
  basename: { module: 'node:path', kind: 'named' },
  extname: { module: 'node:path', kind: 'named' },
  randomUUID: { module: 'node:crypto', kind: 'named' },
  createHash: { module: 'node:crypto', kind: 'named' },
  promisify: { module: 'node:util', kind: 'named' },
  EventEmitter: { module: 'node:events', kind: 'named' },
  fs: { module: 'node:fs', kind: 'default' },
  path: { module: 'node:path', kind: 'default' },
  os: { module: 'node:os', kind: 'default' },
  Router: { module: 'express', kind: 'named', requires: 'express' },
  express: { module: 'express', kind: 'default', requires: 'express' },
  Hono: { module: 'hono', kind: 'named', requires: 'hono' },
  Fastify: { module: 'fastify', kind: 'default', requires: 'fastify' },
  NextResponse: { module: 'next/server', kind: 'named', requires: 'next' },
  NextRequest: { module: 'next/server', kind: 'named', requires: 'next' },
  useRouter: { module: 'next/navigation', kind: 'named', requires: 'next' },
  z: { module: 'zod', kind: 'named', requires: 'zod' },
  axios: { module: 'axios', kind: 'default', requires: 'axios' },
  clsx: { module: 'clsx', kind: 'default', requires: 'clsx' },
  useQuery: { module: '@tanstack/react-query', kind: 'named', requires: '@tanstack/react-query' },
  useMutation: { module: '@tanstack/react-query', kind: 'named', requires: '@tanstack/react-query' },
  describe: { module: 'vitest', kind: 'named', requires: 'vitest' },
  it: { module: 'vitest', kind: 'named', requires: 'vitest' },
  expect: { module: 'vitest', kind: 'named', requires: 'vitest' },
  vi: { module: 'vitest', kind: 'named', requires: 'vitest' },
  test: { module: '@playwright/test', kind: 'named', requires: '@playwright/test' },
};

function knownSymbolFor(ctx: CodeContext, name: string): KnownSymbol | undefined {
  const known = KNOWN_SYMBOLS[name];
  if (!known) {
    return undefined;
  }
  if (known.requires && !ctx.project.dependencies.includes(known.requires)) {
    return undefined;
  }
  if (known.module === 'react' && !ctx.react.isReact && !ctx.project.hasReact) {
    return undefined;
  }
  return known;
}

function selectedIdentifierName(ctx: CodeContext): string | undefined {
  const ast = tsOf(ctx);
  if (ctx.selection.kind === 'identifier' && ast.selectedNode && ts.isIdentifier(ast.selectedNode)) {
    return ast.selectedNode.text;
  }
  if (ctx.selection.kind === 'none' && ts.isIdentifier(ast.nodeAtCursor)) {
    return ast.nodeAtCursor.text;
  }
  return undefined;
}

function isDeclaredSomewhere(ctx: CodeContext, name: string): boolean {
  return (
    ctx.scope.visibleNames.has(name) || ctx.declarations.topLevelNames.has(name) || isImported(ctx, name)
  );
}

function importResultFor(ctx: CodeContext, name: string, known: KnownSymbol): CommandResult {
  const resolution = ensureImports(ctx, [
    known.kind === 'default'
      ? { module: known.module, defaultName: name }
      : { module: known.module, named: [name] },
  ]);
  if (resolution.edits.length === 0) {
    return { message: `${name} is already imported from ${known.module}` };
  }
  return {
    edits: resolution.edits,
    message: `Imported ${name} from ${known.module}${resolution.reused.length ? ' (merged into the existing import)' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Alt+Shift+F1..F3 imports
// ---------------------------------------------------------------------------

export const createImport: CommandDefinition = defineCommand({
  id: 'codepilot.createImport',
  title: 'Create Import',
  category: 'imports',
  description:
    'Imports the selected undeclared identifier from a known module (React, Node builtins, project dependencies), merging with existing imports; otherwise inserts an import statement.',
  keybinding: { key: 'alt+shift+f1' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const name = selectedIdentifierName(ctx);
    if (name && !isDeclaredSomewhere(ctx, name)) {
      const known = knownSymbolFor(ctx, name);
      if (known) {
        return ok(85, `Import ${name} from ${known.module}`);
      }
      return ok(40, `Insert an import for ${name}`);
    }
    if (name && ctx.selection.kind === 'identifier') {
      return no(
        isImported(ctx, name) ? `${name} is already imported.` : `${name} is already declared in this file.`,
      );
    }
    if (ctx.selection.kind !== 'none' && ctx.selection.kind !== 'identifier') {
      return no('Select an identifier to import, or clear the selection.');
    }
    return ok(15, 'Insert an import statement');
  },
  async execute(ctx) {
    const name = selectedIdentifierName(ctx);
    const known = name && !isDeclaredSomewhere(ctx, name) ? knownSymbolFor(ctx, name) : undefined;
    if (name && known) {
      return importResultFor(ctx, name, known);
    }
    const plan = planImportInsertion(ctx);
    const q = ctx.style.quote;
    const sc = semi(ctx);
    const nameText = name && !isDeclaredSomewhere(ctx, name) ? escapeSnippet(name) : '${1:name}';
    return snippetAtPlan(ctx, plan, `import { ${nameText} } from ${q}\${2:module}${q}${sc}`);
  },
});

export const createNamedImport: CommandDefinition = defineCommand({
  id: 'codepilot.createNamedImport',
  title: 'Create Named Import',
  category: 'imports',
  description: 'Inserts (or merges) a named import, prefilled with the selected identifier.',
  keybinding: { key: 'alt+shift+f2' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (ctx.selection.kind !== 'none' && ctx.selection.kind !== 'identifier') {
      return no('Select an identifier or clear the selection.');
    }
    return ok(15, 'Insert a named import');
  },
  async execute(ctx) {
    const name = selectedIdentifierName(ctx);
    const known = name && !isDeclaredSomewhere(ctx, name) ? knownSymbolFor(ctx, name) : undefined;
    if (name && known && known.kind === 'named') {
      return importResultFor(ctx, name, known);
    }
    const q = ctx.style.quote;
    const sc = semi(ctx);
    const nameText = name && !isDeclaredSomewhere(ctx, name) ? escapeSnippet(name) : '${1:name}';
    return snippetAtPlan(
      ctx,
      planImportInsertion(ctx),
      `import { ${nameText} } from ${q}\${2:module}${q}${sc}`,
    );
  },
});

export const createDefaultImport: CommandDefinition = defineCommand({
  id: 'codepilot.createDefaultImport',
  title: 'Create Default Import',
  category: 'imports',
  description: 'Inserts a default import, prefilled with the selected identifier.',
  keybinding: { key: 'alt+shift+f3' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (ctx.selection.kind !== 'none' && ctx.selection.kind !== 'identifier') {
      return no('Select an identifier or clear the selection.');
    }
    return ok(15, 'Insert a default import');
  },
  async execute(ctx) {
    const name = selectedIdentifierName(ctx);
    const known = name && !isDeclaredSomewhere(ctx, name) ? knownSymbolFor(ctx, name) : undefined;
    if (name && known && known.kind === 'default') {
      return importResultFor(ctx, name, known);
    }
    const q = ctx.style.quote;
    const sc = semi(ctx);
    const nameText = name && !isDeclaredSomewhere(ctx, name) ? escapeSnippet(name) : '${1:name}';
    const moduleGuess =
      name && !isDeclaredSomewhere(ctx, name) ? escapeSnippet(name.toLowerCase()) : 'module';
    return snippetAtPlan(
      ctx,
      planImportInsertion(ctx),
      `import ${nameText} from ${q}\${2:${moduleGuess}}${q}${sc}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Alt+Shift+F4..F6 exports
// ---------------------------------------------------------------------------

function exportableDeclaration(ctx: CodeContext): ts.Statement | undefined {
  const decl = getTargetDeclaration(ctx);
  if (!decl || ts.isImportDeclaration(decl) || !decl.parent || !ts.isSourceFile(decl.parent)) {
    return undefined;
  }
  return decl;
}

function declarationName(decl: ts.Statement, sf: ts.SourceFile): string {
  if (ts.isVariableStatement(decl)) {
    return decl.declarationList.declarations[0]?.name.getText(sf) ?? '';
  }
  return (decl as ts.DeclarationStatement).name?.getText(sf) ?? '';
}

export const createExport: CommandDefinition = defineCommand({
  id: 'codepilot.createExport',
  title: 'Create Export',
  category: 'imports',
  description: 'Adds the export keyword to the declaration at the cursor, or inserts an export statement.',
  keybinding: { key: 'alt+shift+f4' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const decl = exportableDeclaration(ctx);
    if (decl) {
      if (isExported(decl)) {
        return no(`${declarationName(decl, tsOf(ctx).sourceFile)} is already exported.`);
      }
      return ok(70, `Export ${declarationName(decl, tsOf(ctx).sourceFile)}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Place the cursor on a top-level declaration to export it.');
    }
    if (ctx.scope.kind !== 'module') {
      return no('Exports must be at the top level of the module.');
    }
    return ok(15, 'Insert an export statement');
  },
  async execute(ctx) {
    const sf = tsOf(ctx).sourceFile;
    const decl = exportableDeclaration(ctx);
    if (decl) {
      const start = decl.getStart(sf);
      return {
        edits: [{ range: { start, end: start }, text: 'export ' }],
        message: `Exported ${declarationName(decl, sf)}`,
      };
    }
    return insertStatementSnippet(ctx, `export \${1|const,function,class,interface,type|} \${2:name}$0`);
  },
});

export const createDefaultExport: CommandDefinition = defineCommand({
  id: 'codepilot.createDefaultExport',
  title: 'Create Default Export',
  category: 'imports',
  description:
    'Makes the declaration at the cursor (or the only component/function in the file) the default export.',
  keybinding: { key: 'alt+shift+f5' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (ctx.declarations.exports.some((e) => e.isDefault)) {
      return no('This module already has a default export.');
    }
    const decl = exportableDeclaration(ctx);
    if (decl) {
      return ok(65, `Make ${declarationName(decl, tsOf(ctx).sourceFile)} the default export`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Place the cursor on a top-level declaration.');
    }
    const candidate =
      ctx.react.components[0]?.name ??
      (ctx.declarations.functions.length === 1 ? ctx.declarations.functions[0].name : undefined);
    return ok(
      candidate ? 40 : 10,
      candidate ? `Add \`export default ${candidate}\`` : 'Insert a default export',
    );
  },
  async execute(ctx) {
    const sf = tsOf(ctx).sourceFile;
    const sc = semi(ctx);
    const decl = exportableDeclaration(ctx);
    if (decl) {
      const name = declarationName(decl, sf);
      if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) {
        const start = decl.getStart(sf);
        if (isExported(decl)) {
          const exportKeyword = ts.getModifiers(decl)?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (exportKeyword) {
            return {
              edits: [
                { range: { start: exportKeyword.getEnd(), end: exportKeyword.getEnd() }, text: ' default' },
              ],
              message: `${name} is now the default export`,
            };
          }
        }
        return {
          edits: [{ range: { start, end: start }, text: 'export default ' }],
          message: `${name} is now the default export`,
        };
      }
      const end = ctx.text.length;
      const needsNewline = !ctx.text.endsWith('\n');
      return {
        edits: [
          {
            range: { start: end, end },
            text: `${needsNewline ? ctx.eol : ''}${ctx.eol}export default ${name}${sc}${ctx.eol}`,
          },
        ],
        message: `Added export default ${name}`,
      };
    }
    const candidate =
      ctx.react.components[0]?.name ??
      (ctx.declarations.functions.length === 1 ? ctx.declarations.functions[0].name : 'name');
    const end = ctx.text.length;
    const needsNewline = !ctx.text.endsWith('\n') && ctx.text.length > 0;
    return {
      snippet: {
        range: { start: end, end },
        body: `${needsNewline ? ctx.eol : ''}${ctx.eol}export default \${1:${escapeSnippet(candidate)}}${sc}${ctx.eol}`,
      },
    };
  },
});

export const createReExport: CommandDefinition = defineCommand({
  id: 'codepilot.createReExport',
  title: 'Create Re-export',
  category: 'imports',
  description: 'Converts the selected import into a re-export, or inserts an `export { } from` statement.',
  keybinding: { key: 'alt+shift+f6' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const decl = getTargetDeclaration(ctx);
    if (
      decl &&
      ts.isImportDeclaration(decl) &&
      decl.importClause?.namedBindings &&
      ts.isNamedImports(decl.importClause.namedBindings)
    ) {
      return ok(
        60,
        `Re-export the bindings imported from ${(decl.moduleSpecifier as ts.StringLiteral).text}`,
      );
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an import declaration or clear the selection.');
    }
    return ok(10, 'Insert a re-export statement');
  },
  async execute(ctx) {
    const sf = tsOf(ctx).sourceFile;
    const sc = semi(ctx);
    const decl = getTargetDeclaration(ctx);
    if (
      decl &&
      ts.isImportDeclaration(decl) &&
      decl.importClause?.namedBindings &&
      ts.isNamedImports(decl.importClause.namedBindings)
    ) {
      const names = decl.importClause.namedBindings.elements.map((e) => e.getText(sf)).join(', ');
      const specifier = decl.moduleSpecifier.getText(sf);
      const typePrefix = decl.importClause.isTypeOnly ? 'type ' : '';
      return {
        edits: [
          {
            range: { start: decl.getEnd(), end: decl.getEnd() },
            text: `${ctx.eol}export ${typePrefix}{ ${names} } from ${specifier}${sc}`,
          },
        ],
        message: `Added re-export for ${names}`,
      };
    }
    const q = ctx.style.quote;
    return snippetAtPlan(
      ctx,
      planAfterImports(ctx),
      `export { \${1:name} } from ${q}\${2:./module}${q}${sc}`,
    );
  },
});

// ---------------------------------------------------------------------------
// Alt+Shift+F7 Destructuring
// ---------------------------------------------------------------------------

function propertyNamesForExpression(ctx: CodeContext, expr: ts.Expression): string[] | undefined {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const e = unwrapExpression(expr);
  let typeName: string | undefined;
  if (ts.isIdentifier(e)) {
    const variable = ctx.declarations.variables.find((v) => v.name === e.text);
    if (variable?.initializerKind === 'object') {
      const stmt = sf.statements.find(
        (s) => ts.isVariableStatement(s) && s.getStart(sf) === variable.range.start,
      ) as ts.VariableStatement | undefined;
      const d = stmt?.declarationList.declarations.find(
        (x) => ts.isIdentifier(x.name) && x.name.text === e.text,
      );
      if (d?.initializer && ts.isObjectLiteralExpression(d.initializer)) {
        return d.initializer.properties
          .map((p) => p.name?.getText(sf) ?? '')
          .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
      }
    }
    typeName = variable?.typeText;
    const fn = ast.enclosingFunctionNode;
    const param = fn?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === e.text);
    if (param?.type) {
      typeName = param.type.getText(sf);
    }
    if (!typeName) {
      typeName = checkerTypeText(ast.getChecker(), e);
    }
    if (typeName) {
      const iface = ctx.declarations.interfaces.find((i) => i.name === typeName);
      if (iface) {
        return iface.members.map((m) => m.name);
      }
      const alias = ctx.declarations.types.find((t) => t.name === typeName);
      if (alias?.members) {
        return alias.members.map((m) => m.name);
      }
      const inline = /^\{\s*(.*)\s*\}$/s.exec(typeName);
      if (inline) {
        const names = inline[1]
          .split(/[;,]/)
          .map((s) => s.trim().split(/[?:]/)[0].trim())
          .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
        if (names.length) {
          return names;
        }
      }
    }
  }
  return undefined;
}

export const createDestructuring: CommandDefinition = defineCommand({
  id: 'codepilot.createDestructuring',
  title: 'Create Destructuring',
  category: 'imports',
  description:
    'Destructures the selected object using the properties of its known type or literal, or inserts a destructuring declaration.',
  keybinding: { key: 'alt+shift+f7' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const props = propertyNamesForExpression(ctx, expr);
      return ok(
        props ? 75 : 45,
        props
          ? `Destructure { ${props.slice(0, 4).join(', ')}${props.length > 4 ? ', ...' : ''} } from ${describeSelection(ctx)}`
          : `Destructure ${describeSelection(ctx)}`,
      );
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select the object expression to destructure.');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(10, 'Insert a destructuring declaration');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const ast = tsOf(ctx);
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const text = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
      const props = propertyNamesForExpression(ctx, expr);
      const isArray =
        /\[\]$|^Array</.test(checkerTypeText(ast.getChecker(), expr) ?? '') ||
        (ts.isIdentifier(expr) && isArrayName(ctx, expr.text));
      const pattern = props
        ? `{ ${props.map((p, i) => `\${${i + 1}:${escapeSnippet(p)}}`).join(', ')} }`
        : isArray
          ? `[\${1:first}]`
          : `{ \${1:property} }`;
      const template = `const ${pattern} = ${escapeSnippet(text)}${sc}`;
      const stmt = expr.parent && ts.isExpressionStatement(expr.parent) ? expr.parent : undefined;
      if (stmt) {
        const start = stmt.getStart(ast.sourceFile);
        return {
          snippet: {
            range: { start, end: stmt.getEnd() },
            body: renderCode(template, ctx, lineIndentAt(ctx.text, start)),
          },
        };
      }
      // Sub-expression: add the declaration after the enclosing statement.
      const enclosing = ast.enclosingStatementNode ?? ast.selectedStatements[0];
      if (enclosing) {
        const end = enclosing.getEnd();
        const indent = lineIndentAt(ctx.text, enclosing.getStart(ast.sourceFile));
        return {
          snippet: {
            range: { start: end, end },
            body: escapeSnippet(ctx.eol + indent) + renderCode(template, ctx, indent),
          },
        };
      }
      return insertStatementSnippet(ctx, template);
    }
    return insertStatementSnippet(ctx, `const { \${1:property} } = \${2:object}${sc}`);
  },
});

function isArrayName(ctx: CodeContext, name: string): boolean {
  const v = ctx.declarations.variables.find((x) => x.name === name);
  return !!v && (v.initializerKind === 'array' || /\[\]$|^Array</.test(v.typeText ?? ''));
}

// ---------------------------------------------------------------------------
// Alt+Shift+F8 Spread
// ---------------------------------------------------------------------------

export const createSpread: CommandDefinition = defineCommand({
  id: 'codepilot.createSpread',
  title: 'Create Spread',
  category: 'imports',
  description: 'Spreads the selected expression into an array or object literal depending on its type.',
  keybinding: { key: 'alt+shift+f8' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      return ok(45, `Spread ${describeSelection(ctx)}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select the expression to spread.');
    }
    return ok(10, 'Insert a spread element');
  },
  async execute(ctx) {
    const ast = tsOf(ctx);
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const text = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
      const type = checkerTypeText(ast.getChecker(), expr) ?? '';
      const arrayish =
        ts.isArrayLiteralExpression(unwrapExpression(expr)) ||
        /\[\]$|^Array<|^ReadonlyArray</.test(type) ||
        (ts.isIdentifier(expr) && isArrayName(ctx, expr.text));
      const parent = expr.parent;
      if (
        parent &&
        (ts.isArrayLiteralExpression(parent) ||
          ts.isObjectLiteralExpression(parent) ||
          ts.isCallExpression(parent))
      ) {
        return { edits: [{ range: ctx.selection.range, text: `...${text}` }] };
      }
      const body = arrayish ? `[...${escapeSnippet(text)}\${1}]` : `{ ...${escapeSnippet(text)}\${1} }`;
      return { snippet: { range: ctx.selection.range, body } };
    }
    return { snippet: { range: { start: ctx.cursor, end: ctx.cursor }, body: `...\${1:value}` } };
  },
});

// ---------------------------------------------------------------------------
// Alt+Shift+F9 Optional Chaining
// ---------------------------------------------------------------------------

function chainAtCursor(ctx: CodeContext): ts.Expression | undefined {
  const ast = tsOf(ctx);
  let node: ts.Node | undefined = ast.nodeAtCursor;
  let best: ts.Expression | undefined;
  while (node && !ts.isStatement(node) && !ts.isSourceFile(node)) {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      (ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)))
    ) {
      best = node;
    } else if (best) {
      break;
    }
    node = node.parent;
  }
  return best;
}

export const createOptionalChaining: CommandDefinition = defineCommand({
  id: 'codepilot.createOptionalChaining',
  title: 'Create Optional Chaining',
  category: 'imports',
  description:
    'Rewrites the selected member-access chain (or the one at the cursor) with optional chaining: `a.b.c` → `a?.b?.c`.',
  keybinding: { key: 'alt+shift+f9' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? chainAtCursor(ctx) : getSelectedExpression(ctx);
    if (
      expr &&
      (ts.isPropertyAccessExpression(unwrapExpression(expr)) ||
        ts.isElementAccessExpression(unwrapExpression(expr)) ||
        ts.isCallExpression(unwrapExpression(expr)))
    ) {
      if (/\?\./.test(expr.getText())) {
        return no('The expression already uses optional chaining.');
      }
      return ok(60, `Make \`${expr.getText().slice(0, 30)}\` null-safe`);
    }
    return no('Select a property access chain such as `user.profile.name`.');
  },
  async execute(ctx) {
    const ast = tsOf(ctx);
    const expr = ctx.selection.kind === 'none' ? chainAtCursor(ctx) : getSelectedExpression(ctx);
    if (!expr) {
      throw new CodePilotError(
        'invalidSelection',
        'Select a property access chain such as `user.profile.name`.',
      );
    }
    const converted = toOptionalChain(ctx, expr);
    return {
      edits: [{ range: { start: expr.getStart(ast.sourceFile), end: expr.getEnd() }, text: converted }],
      message: `Rewrote as ${converted}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Alt+Shift+F10 Nullish Coalescing
// ---------------------------------------------------------------------------

export const createNullishCoalescing: CommandDefinition = defineCommand({
  id: 'codepilot.createNullishCoalescing',
  title: 'Create Nullish Coalescing',
  category: 'imports',
  description: 'Converts `a || b` into `a ?? b`, or appends `?? default` to the selected expression.',
  keybinding: { key: 'alt+shift+f10' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      if (orToNullish(ctx, unwrapExpression(expr))) {
        return ok(75, 'Convert `||` into `??`');
      }
      return ok(35, `Add a fallback with \`??\` to ${describeSelection(ctx)}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an expression.');
    }
    return ok(10, 'Insert `?? fallback`');
  },
  async execute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const converted = orToNullish(ctx, unwrapExpression(expr));
      if (converted) {
        return { edits: [{ range: ctx.selection.range, text: converted }], message: 'Converted || into ??' };
      }
      const text = escapeSnippet(ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end));
      return { snippet: { range: ctx.selection.range, body: `${text} ?? \${1:fallback}` } };
    }
    const before = ctx.text[ctx.cursor - 1];
    const space = before && !/\s/.test(before) ? ' ' : '';
    return { snippet: { range: { start: ctx.cursor, end: ctx.cursor }, body: `${space}?? \${1:fallback}` } };
  },
});

// ---------------------------------------------------------------------------
// Alt+Shift+F11 Promise
// ---------------------------------------------------------------------------

function sequentialAwaits(ctx: CodeContext): { names: string[]; exprs: string[] } | undefined {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const stmts = ast.selectedStatements;
  if (stmts.length < 2) {
    return undefined;
  }
  const names: string[] = [];
  const exprs: string[] = [];
  for (const s of stmts) {
    if (!ts.isVariableStatement(s) || s.declarationList.declarations.length !== 1) {
      return undefined;
    }
    const d = s.declarationList.declarations[0];
    if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isAwaitExpression(d.initializer)) {
      return undefined;
    }
    // Later awaits must not depend on earlier results.
    const refs = collectValueReferences(d.initializer);
    if (names.some((n) => refs.has(n))) {
      return undefined;
    }
    names.push(d.name.text);
    exprs.push(d.initializer.expression.getText(sf));
  }
  return { names, exprs };
}

export const createPromise: CommandDefinition = defineCommand({
  id: 'codepilot.createPromise',
  title: 'Create Promise',
  category: 'imports',
  description:
    'Combines independent sequential awaits into Promise.all, wraps statements in a Promise executor, or inserts a new Promise.',
  keybinding: { key: 'alt+shift+f11' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (sequentialAwaits(ctx)) {
      return ok(85, `Run ${ctx.selection.statementCount} independent awaits in parallel with Promise.all`);
    }
    if (ctx.selection.kind === 'statements') {
      return ok(35, `Wrap ${describeSelection(ctx)} in a Promise executor`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select complete statements or clear the selection.');
    }
    return ok(10, 'Insert a new Promise');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const ast = tsOf(ctx);
    const parallel = sequentialAwaits(ctx);
    if (parallel) {
      const first = ast.selectedStatements[0];
      const last = ast.selectedStatements[ast.selectedStatements.length - 1];
      const isConst = ast.selectedStatements.every(
        (s) => ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const) !== 0,
      );
      const text = `${isConst ? 'const' : 'let'} [${parallel.names.join(', ')}] = await Promise.all([${parallel.exprs.join(', ')}])${sc}`;
      return {
        edits: [{ range: { start: first.getStart(ast.sourceFile), end: last.getEnd() }, text }],
        message: `Combined ${parallel.names.length} awaits into Promise.all`,
      };
    }
    if (ctx.selection.kind === 'statements') {
      const generic = ctx.language.isTypeScript ? '<${1:void}>' : '';
      const prefix = ctx.scope.isAsync ? 'await ' : 'return ';
      return wrapStatements(ctx, {
        before: `${prefix}new Promise${generic}((resolve, reject) => {\n\t`,
        after: `\n\tresolve(\${2})${sc}\n})${sc}`,
      });
    }
    const generic = ctx.language.isTypeScript ? '<${1:void}>' : '';
    return {
      snippet: {
        range: { start: ctx.cursor, end: ctx.cursor },
        body: renderCode(
          `new Promise${generic}((resolve, reject) => {\n\t$0\n})`,
          ctx,
          ctx.currentLine.indent,
        ),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Alt+Shift+F12 Async / Await
// ---------------------------------------------------------------------------

function asyncKeywordEdit(ctx: CodeContext, fn: FunctionLikeNode): TextEdit | undefined {
  const sf = tsOf(ctx).sourceFile;
  if (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    return undefined;
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const start = fn.getStart(sf);
    return { range: { start, end: start }, text: 'async ' };
  }
  if (ts.isFunctionDeclaration(fn)) {
    const fnKeyword = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
    const pos = fnKeyword ? fnKeyword.getStart(sf) : fn.getStart(sf);
    return { range: { start: pos, end: pos }, text: 'async ' };
  }
  if (ts.isMethodDeclaration(fn)) {
    const pos = fn.name.getStart(sf);
    return { range: { start: pos, end: pos }, text: 'async ' };
  }
  return undefined;
}

export const createAsyncAwait: CommandDefinition = defineCommand({
  id: 'codepilot.createAsyncAwait',
  title: 'Create Async / Await',
  category: 'imports',
  description:
    'Converts `.then()` chains to await, awaits the selected expression (making the enclosing function async), or marks the enclosing function async.',
  keybinding: { key: 'alt+shift+f12' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const ast = tsOf(ctx);
    if (
      ast.selectedStatements.length === 1 &&
      ts.isExpressionStatement(ast.selectedStatements[0]) &&
      thenToAwait(ctx, ast.selectedStatements[0] as ts.ExpressionStatement)
    ) {
      return ok(85, 'Convert the .then() chain to async/await');
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      if (ts.isAwaitExpression(expr)) {
        return no('The expression is already awaited.');
      }
      return ok(
        55,
        `Await ${describeSelection(ctx)}${ctx.scope.enclosingFunction && !ctx.scope.isAsync ? ' and make the function async' : ''}`,
      );
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an expression or a .then() statement.');
    }
    const fn = ctx.scope.enclosingFunction;
    if (fn && !fn.isAsync) {
      return ok(45, `Make ${fn.name || 'the enclosing function'} async`);
    }
    if (fn?.isAsync) {
      return no(`${fn.name || 'The enclosing function'} is already async.`);
    }
    return ok(10, 'Insert an async function');
  },
  async execute(ctx) {
    const ast = tsOf(ctx);
    const sf = ast.sourceFile;
    const edits: TextEdit[] = [];
    const fnNode = ast.enclosingFunctionNode;
    if (ast.selectedStatements.length === 1 && ts.isExpressionStatement(ast.selectedStatements[0])) {
      const stmt = ast.selectedStatements[0] as ts.ExpressionStatement;
      const converted = thenToAwait(ctx, stmt);
      if (converted) {
        const start = stmt.getStart(sf);
        edits.push({
          range: { start, end: stmt.getEnd() },
          text: renderCode(converted.code, ctx, lineIndentAt(ctx.text, start)),
        });
        const asyncEdit = fnNode ? asyncKeywordEdit(ctx, fnNode) : undefined;
        if (asyncEdit) {
          edits.push(asyncEdit);
        }
        return { edits, message: 'Converted .then() to await' };
      }
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const text = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
      const needsParens = ts.isBinaryExpression(expr) || ts.isConditionalExpression(expr);
      edits.push({ range: ctx.selection.range, text: `await ${needsParens ? `(${text})` : text}` });
      const owner = getEnclosingFunction(expr);
      const asyncEdit = owner ? asyncKeywordEdit(ctx, owner) : undefined;
      if (asyncEdit) {
        edits.push(asyncEdit);
      }
      return {
        edits,
        message: asyncEdit
          ? 'Awaited the expression and made the enclosing function async'
          : 'Awaited the expression',
      };
    }
    if (fnNode) {
      const asyncEdit = asyncKeywordEdit(ctx, fnNode);
      if (asyncEdit) {
        const hasThen = /\.then\(/.test(fnNode.getText(sf));
        return {
          edits: [asyncEdit],
          message: hasThen
            ? 'Marked the function async (select a .then() statement to convert it to await)'
            : 'Marked the function async',
        };
      }
      throw new CodePilotError('unavailable', 'The enclosing function is already async.');
    }
    if (!canInsertStatement(ctx)) {
      throw new CodePilotError('unavailable', statementScopeReason(ctx));
    }
    const ret = ctx.language.isTypeScript ? ': Promise<${2:void}>' : '';
    return snippetAtPlan(ctx, planStatementInsertion(ctx), `async function \${1:run}()${ret} {\n\t$0\n}`);
  },
});

export const importCommands: CommandDefinition[] = [
  createImport,
  createNamedImport,
  createDefaultImport,
  createExport,
  createDefaultExport,
  createReExport,
  createDestructuring,
  createSpread,
  createOptionalChaining,
  createNullishCoalescing,
  createPromise,
  createAsyncAwait,
];
