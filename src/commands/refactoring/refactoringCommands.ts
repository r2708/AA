/**
 * Refactoring commands (Command Palette + Smart Action; default keys Ctrl+Alt+Shift+<letter>).
 * They reuse the same transformations as the core commands but require explicit targets.
 */
import * as ts from 'typescript';
import type { CommandDefinition } from '../../types/command';
import { CodePilotError } from '../../types/command';
import { defineCommand } from '../commandRegistry';
import { JS_LANGUAGES, describeSelection, no, ok } from '../helpers';
import {
  getSelectedExpression,
  getTargetDeclaration,
  getTargetObjectLiteral,
  lineIndentAt,
  tsOf,
} from '../../languages/typescript/tsContext';
import { analyzeExtraction, extractFunction } from '../../transformations/extractFunction';
import { extractConstant, extractVariable } from '../../transformations/extractVariable';
import { wrapStatements } from '../../transformations/wrap';
import { jsDocSnippetFor } from '../../generators/docGenerator';
import { escapeSnippet, renderCode, semi } from '../../generators/codeWriter';
import { uniqueName } from '../../analyzer/naming';
import { createImport } from '../imports/importCommands';
import { createInterface, createType } from '../core/coreCommands';

export const extractFunctionCommand: CommandDefinition = defineCommand({
  id: 'codepilot.extractFunction',
  title: 'Extract Function',
  category: 'refactoring',
  description:
    'Extracts the selected statements/expression into a function or method, inferring parameters, return value and async-ness.',
  keybinding: { key: 'ctrl+alt+shift+e' },
  supportedLanguages: JS_LANGUAGES,
  requiresSelection: true,
  canExecute(ctx) {
    if (
      ctx.selection.kind !== 'statements' &&
      ctx.selection.kind !== 'expression' &&
      ctx.selection.kind !== 'identifier'
    ) {
      return no('Select complete statements or a single expression to extract.');
    }
    try {
      const analysis = analyzeExtraction(ctx);
      if (analysis.hasConditionalReturn) {
        return no('The selection contains a return inside a nested block; select a smaller block.');
      }
      const params = analysis.params.map((p) => p.name).join(', ');
      return ok(
        80,
        `Extract ${describeSelection(ctx)} into ${analysis.asMethod ? 'method' : 'function'} ${analysis.suggestedName}(${params})`,
      );
    } catch (error) {
      return no(error instanceof Error ? error.message : String(error));
    }
  },
  execute: async (ctx) => extractFunction(ctx),
});

export const extractVariableCommand: CommandDefinition = defineCommand({
  id: 'codepilot.extractVariable',
  title: 'Extract Variable',
  category: 'refactoring',
  description: 'Extracts the selected expression into a const with a name derived from the expression.',
  keybinding: { key: 'ctrl+alt+shift+v' },
  supportedLanguages: JS_LANGUAGES,
  requiresSelection: true,
  canExecute(ctx) {
    const expr = getSelectedExpression(ctx);
    if (!expr) {
      return no('Select an expression to extract into a variable.');
    }
    return ok(75, `Extract ${describeSelection(ctx)} into a variable`);
  },
  execute: async (ctx) => extractVariable(ctx, { annotate: false }),
});

export const extractConstantCommand: CommandDefinition = defineCommand({
  id: 'codepilot.extractConstant',
  title: 'Extract Constant',
  category: 'refactoring',
  description: 'Hoists the selected literal into a module-level constant and replaces duplicate literals.',
  keybinding: { key: 'ctrl+alt+shift+c' },
  supportedLanguages: JS_LANGUAGES,
  requiresSelection: true,
  canExecute(ctx) {
    const expr = getSelectedExpression(ctx);
    if (!expr) {
      return no('Select a literal or expression to extract into a constant.');
    }
    return ok(65, `Extract ${describeSelection(ctx)} into a module constant`);
  },
  execute: async (ctx) => extractConstant(ctx),
});

export const generateImportCommand: CommandDefinition = defineCommand({
  id: 'codepilot.generateImport',
  title: 'Generate Import',
  category: 'refactoring',
  description:
    'Generates the import for the undeclared identifier under the cursor (React, Node builtins and project dependencies), merging with existing imports.',
  keybinding: { key: 'ctrl+alt+shift+i' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const result = createImport.canExecute(ctx);
    if (result.available && (result.score ?? 0) >= 40) {
      return result;
    }
    return no('Place the cursor on an undeclared identifier to generate its import.');
  },
  execute: (ctx, ui) => createImport.execute(ctx, ui),
});

export const generateTypeCommand: CommandDefinition = defineCommand({
  id: 'codepilot.generateType',
  title: 'Generate Type',
  category: 'refactoring',
  description:
    'Generates a type alias from the selected object literal, string array or expression (TypeScript).',
  keybinding: { key: 'ctrl+alt+shift+t' },
  supportedLanguages: JS_LANGUAGES,
  requiresSelection: true,
  canExecute(ctx) {
    const result = createType.canExecute(ctx);
    return result.available && (result.score ?? 0) >= 40
      ? result
      : no(result.reason ?? 'Select an object literal or expression to generate a type from.');
  },
  execute: (ctx, ui) => createType.execute(ctx, ui),
});

export const generateInterfaceCommand: CommandDefinition = defineCommand({
  id: 'codepilot.generateInterface',
  title: 'Generate Interface',
  category: 'refactoring',
  description: 'Generates an interface from the selected object literal (recursively) or class.',
  keybinding: { key: 'ctrl+alt+shift+n' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (!getTargetObjectLiteral(ctx)) {
      const decl = getTargetDeclaration(ctx);
      if (!(decl && ts.isClassDeclaration(decl))) {
        return no(
          'Select an object literal (or place the cursor inside one / on a class) to generate an interface.',
        );
      }
    }
    return createInterface.canExecute(ctx);
  },
  execute: (ctx, ui) => createInterface.execute(ctx, ui),
});

export const generateDocumentationCommand: CommandDefinition = defineCommand({
  id: 'codepilot.generateDocumentation',
  title: 'Generate Documentation',
  category: 'refactoring',
  description:
    'Generates a JSDoc block for the declaration at the cursor (@param/@returns/@throws from the signature and body).',
  keybinding: { key: 'ctrl+alt+shift+d' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const target = documentationTarget(ctx);
    if (!target) {
      return no('Place the cursor on a function, class, interface, type, enum or variable declaration.');
    }
    if (hasJsDoc(ctx, target)) {
      return no('The declaration already has a JSDoc comment.');
    }
    return ok(50, `Document ${describeNode(target)}`);
  },
  async execute(ctx) {
    const target = documentationTarget(ctx);
    if (!target) {
      throw new CodePilotError('unavailable', 'Place the cursor on a declaration to document.');
    }
    const snippet = jsDocSnippetFor(ctx, target);
    if (!snippet) {
      throw new CodePilotError('unavailable', 'This declaration kind cannot be documented automatically.');
    }
    const sf = tsOf(ctx).sourceFile;
    const start = target.getStart(sf);
    const indent = lineIndentAt(ctx.text, start);
    const body = renderCode(snippet, ctx, indent) + escapeSnippet(ctx.eol + indent);
    return { snippet: { range: { start, end: start }, body } };
  },
});

function documentationTarget(ctx: CodeContext): ts.Node | undefined {
  const ast = tsOf(ctx);
  const decl = getTargetDeclaration(ctx);
  if (decl && !ts.isImportDeclaration(decl)) {
    // Prefer an enclosing method/property inside a class when the cursor is there.
    if (ts.isClassDeclaration(decl) && ctx.selection.kind === 'none') {
      let node: ts.Node | undefined = ast.nodeAtCursor;
      while (node && node !== decl) {
        if (
          ts.isMethodDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isConstructorDeclaration(node)
        ) {
          return node;
        }
        node = node.parent;
      }
    }
    return decl;
  }
  return undefined;
}

function hasJsDoc(ctx: CodeContext, node: ts.Node): boolean {
  const sf = tsOf(ctx).sourceFile;
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  return ranges.some((r) => sf.text.slice(r.pos, r.pos + 3) === '/**');
}

function describeNode(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) {
    return `function ${node.name?.text ?? ''}`;
  }
  if (ts.isClassDeclaration(node)) {
    return `class ${node.name?.text ?? ''}`;
  }
  if (ts.isInterfaceDeclaration(node)) {
    return `interface ${node.name.text}`;
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return `type ${node.name.text}`;
  }
  if (ts.isEnumDeclaration(node)) {
    return `enum ${node.name.text}`;
  }
  if (ts.isMethodDeclaration(node)) {
    return `method ${node.name.getText()}`;
  }
  if (ts.isVariableStatement(node)) {
    return `${node.declarationList.declarations[0]?.name.getText() ?? 'variable'}`;
  }
  return 'the declaration';
}

function wrapCommand(
  id: string,
  title: string,
  key: string,
  description: string,
  before: (ctx: CodeContext) => string,
  after: (ctx: CodeContext) => string,
  detail: string,
): CommandDefinition {
  return defineCommand({
    id,
    title,
    category: 'refactoring',
    description,
    keybinding: { key },
    supportedLanguages: JS_LANGUAGES,
    requiresSelection: true,
    canExecute(ctx) {
      if (ctx.selection.kind !== 'statements' && ctx.selection.kind !== 'declaration') {
        return no('Select one or more complete statements to wrap.');
      }
      return ok(55, `${detail} ${describeSelection(ctx)}`);
    },
    execute: async (ctx) => wrapStatements(ctx, { before: before(ctx), after: after(ctx) }),
  });
}

export const wrapWithTryCatchCommand = wrapCommand(
  'codepilot.wrapWithTryCatch',
  'Wrap With Try/Catch',
  'ctrl+alt+shift+w',
  'Wraps the selected statements in a try/catch block.',
  () => 'try {\n\t',
  (ctx) => {
    const err = uniqueName('error', ctx.scope.visibleNames);
    return `\n} catch (${err}) {\n\t\${1:console.error(${err})${semi(ctx)}}\n}`;
  },
  'Wrap in try/catch',
);

export const wrapWithIfCommand = wrapCommand(
  'codepilot.wrapWithIf',
  'Wrap With If',
  'ctrl+alt+shift+y',
  'Wraps the selected statements in an if block.',
  () => 'if (${1:condition}) {\n\t',
  () => '\n}',
  'Wrap in if',
);

export const wrapWithLoopCommand: CommandDefinition = defineCommand({
  id: 'codepilot.wrapWithLoop',
  title: 'Wrap With Loop',
  category: 'refactoring',
  description: 'Wraps the selected statements in a loop of your choice (for...of, for, while).',
  keybinding: { key: 'ctrl+alt+shift+l' },
  supportedLanguages: JS_LANGUAGES,
  requiresSelection: true,
  canExecute(ctx) {
    if (ctx.selection.kind !== 'statements' && ctx.selection.kind !== 'declaration') {
      return no('Select one or more complete statements to wrap.');
    }
    return ok(45, `Wrap ${describeSelection(ctx)} in a loop`);
  },
  async execute(ctx, ui) {
    const choice = await ui.pick(
      [
        { label: 'for...of', description: 'iterate the items of an array', value: 'of' as const },
        { label: 'for (let i = 0; ...)', description: 'index-based loop', value: 'index' as const },
        { label: 'while', description: 'loop while a condition holds', value: 'while' as const },
      ],
      { title: 'Wrap With Loop', placeholder: 'Which loop?' },
    );
    if (!choice) {
      return { cancelled: true };
    }
    const before =
      choice === 'of'
        ? 'for (const ${1:item} of ${2:items}) {\n\t'
        : choice === 'index'
          ? 'for (let ${1:i} = 0; ${1} < ${2:items}.length; ${1}++) {\n\t'
          : 'while (${1:condition}) {\n\t';
    return wrapStatements(ctx, { before, after: '\n}' });
  },
});

export const refactoringCommands: CommandDefinition[] = [
  extractFunctionCommand,
  extractVariableCommand,
  extractConstantCommand,
  generateImportCommand,
  generateTypeCommand,
  generateInterfaceCommand,
  generateDocumentationCommand,
  wrapWithTryCatchCommand,
  wrapWithIfCommand,
  wrapWithLoopCommand,
];

type CodeContext = import('../../types/context').CodeContext;
