/**
 * Core commands (Shift+F1 ... Shift+F12).
 */
import * as ts from 'typescript';
import type { CodeContext, InterfaceInfo, TypeAliasInfo } from '../../types/context';
import {
  CodePilotError,
  type CommandDefinition,
  type CommandResult,
  type PickItem,
  type UserInteraction,
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
  findUndeclaredCalls,
  getClassInfo,
  getInterfaceInfo,
  getUnionLiterals,
  type UndeclaredCall,
} from '../../analyzer/astAnalyzer';
import {
  getAssignedName,
  getSelectedExpression,
  getTargetDeclaration,
  getTargetObjectLiteral,
  lineIndentAt,
  tsOf,
  unwrapExpression,
} from '../../languages/typescript/tsContext';
import {
  toPascalCase,
  uniqueName,
  singularize,
  pluralize,
  uncapitalize,
  isValidIdentifier,
} from '../../analyzer/naming';
import { checkerTypeText } from '../../analyzer/typeInference';
import { extractFunction } from '../../transformations/extractFunction';
import { extractConstant, extractVariable } from '../../transformations/extractVariable';
import {
  planClassMemberInsertion,
  planInterfaceMemberInsertion,
  planTopLevelInsertion,
  type InsertionPlan,
} from '../../transformations/insertion';
import {
  functionSkeletonSnippet,
  functionStubSnippet,
  methodSkeletonSnippet,
} from '../../generators/functionGenerator';
import { generateTypeFromObjectLiteral, shapeFromObjectLiteral } from '../../generators/interfaceGenerator';
import {
  classSkeletonSnippet,
  generateClassCode,
  membersFromProperties,
} from '../../generators/classGenerator';
import { objectLiteralForShape, shapeFromDeclaration } from '../../generators/dataGenerator';
import { escapeSnippet, renderCode, semi, typePlaceholder } from '../../generators/codeWriter';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function undeclaredCallsNearCursor(ctx: CodeContext): UndeclaredCall[] {
  const ast = tsOf(ctx);
  const root = ast.enclosingStatementNode;
  if (!root) {
    return [];
  }
  const visible = new Set([...ctx.scope.visibleNames, ...ctx.declarations.topLevelNames]);
  return findUndeclaredCalls(root, visible);
}

/** Interface enclosing the cursor, selected, or immediately preceding the cursor statement. */
function nearbyInterface(
  ctx: CodeContext,
): { info: InterfaceInfo; node: ts.InterfaceDeclaration; explicit: boolean } | undefined {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const decl = getTargetDeclaration(ctx);
  if (decl && ts.isInterfaceDeclaration(decl)) {
    return { info: getInterfaceInfo(decl, sf), node: decl, explicit: true };
  }
  if (ctx.selection.kind === 'identifier' && ast.selectedNode && ts.isIdentifier(ast.selectedNode)) {
    const name = ast.selectedNode.text;
    const found = sf.statements.find(
      (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
    );
    if (found) {
      return { info: getInterfaceInfo(found, sf), node: found, explicit: true };
    }
  }
  if (ctx.selection.kind !== 'none') {
    return undefined;
  }
  const top = ast.topLevelStatementNode;
  const index = top
    ? sf.statements.indexOf(top)
    : sf.statements.findIndex((s) => s.getStart(sf) > ctx.cursor);
  const previous = index > 0 ? sf.statements[index - 1] : undefined;
  if (previous && ts.isInterfaceDeclaration(previous) && !top) {
    return { info: getInterfaceInfo(previous, sf), node: previous, explicit: false };
  }
  if (previous && ts.isInterfaceDeclaration(previous) && top && ts.isInterfaceDeclaration(top) === false) {
    // cursor on the statement right after an interface: only auto-use when the cursor line is blank
    if (ctx.currentLine.isBlank) {
      return { info: getInterfaceInfo(previous, sf), node: previous, explicit: false };
    }
  }
  return undefined;
}

/** Interface or object-like type alias targeted by the cursor/selection. */
function targetShapeDeclaration(ctx: CodeContext): InterfaceInfo | TypeAliasInfo | undefined {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const decl = getTargetDeclaration(ctx);
  if (decl && ts.isInterfaceDeclaration(decl)) {
    return getInterfaceInfo(decl, sf);
  }
  if (decl && ts.isTypeAliasDeclaration(decl)) {
    return ctx.declarations.types.find((t) => t.name === decl.name.text && t.members);
  }
  if (ctx.selection.kind === 'identifier' && ast.selectedNode && ts.isIdentifier(ast.selectedNode)) {
    const name = ast.selectedNode.text;
    return (
      ctx.declarations.interfaces.find((i) => i.name === name) ??
      ctx.declarations.types.find((t) => t.name === name && t.members)
    );
  }
  if (ctx.selection.kind === 'none') {
    const near = nearbyInterface(ctx);
    if (near) {
      return near.info;
    }
  }
  return undefined;
}

function uniqueTypeName(ctx: CodeContext, base: string): string {
  return uniqueName(base, ctx.declarations.topLevelNames);
}

function typeNameForObject(ctx: CodeContext, obj: ts.ObjectLiteralExpression, fallback: string): string {
  const assigned = getAssignedName(obj);
  if (assigned) {
    return toPascalCase(assigned);
  }
  if (ctx.react.enclosingComponent) {
    return `${ctx.react.enclosingComponent.name}${fallback}`;
  }
  return fallback;
}

function annotateVariableEdit(ctx: CodeContext, obj: ts.ObjectLiteralExpression, typeName: string) {
  if (!ctx.language.isTypeScript) {
    return undefined;
  }
  const parent = obj.parent;
  if (parent && ts.isVariableDeclaration(parent) && !parent.type && ts.isIdentifier(parent.name)) {
    const end = parent.name.getEnd();
    return { range: { start: end, end }, text: `: ${typeName}` };
  }
  return undefined;
}

function pickOrDefault<T>(ui: UserInteraction, items: PickItem<T>[], title: string): Promise<T | undefined> {
  return ui.pick(items, { title, placeholder: 'CodePilot' });
}

// ---------------------------------------------------------------------------
// Shift+F1 Create Function
// ---------------------------------------------------------------------------

export const createFunction: CommandDefinition = defineCommand({
  id: 'codepilot.createFunction',
  title: 'Create Function',
  category: 'core',
  description:
    'Creates a function from context: extracts the selection, stubs an undeclared call, adds a method inside a class, or inserts a skeleton.',
  keybinding: { key: 'shift+f1' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (ctx.selection.kind === 'statements' || ctx.selection.kind === 'expression') {
      return ok(
        75,
        `Extract ${describeSelection(ctx)} into a ${ctx.scope.enclosingClass ? 'method' : 'function'}`,
      );
    }
    if (ctx.selection.kind !== 'none') {
      return no(
        'Select complete statements or a single expression to extract, or clear the selection to insert a function.',
      );
    }
    const undeclared = undeclaredCallsNearCursor(ctx);
    if (undeclared.length) {
      return ok(
        85,
        `Create ${undeclared[0].isAwaited ? 'async ' : ''}function ${undeclared[0].name}() from its call`,
      );
    }
    if (ctx.scope.inClassBody && ctx.scope.enclosingClass) {
      return ok(45, `Add a method to class ${ctx.scope.enclosingClass.name}`);
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(25, 'Insert a function skeleton');
  },
  async execute(ctx, ui) {
    if (ctx.selection.kind !== 'none') {
      return extractFunction(ctx);
    }
    const undeclared = undeclaredCallsNearCursor(ctx);
    if (undeclared.length) {
      let target = undeclared[0];
      if (undeclared.length > 1) {
        const picked = await pickOrDefault(
          ui,
          undeclared.map((u) => ({
            label: `${u.name}()`,
            description: u.isAwaited ? 'awaited call' : 'call',
            value: u,
          })),
          'Create which function?',
        );
        if (!picked) {
          return { cancelled: true };
        }
        target = picked;
      }
      const plan = planTopLevelInsertion(ctx, { position: 'after' });
      return snippetAtPlan(ctx, plan, functionStubSnippet(ctx, target), {
        message: `Created ${target.isAwaited ? 'async ' : ''}function ${target.name}() with ${target.argumentNodes.length} parameter${target.argumentNodes.length === 1 ? '' : 's'} inferred from the call`,
      });
    }
    if (ctx.scope.inClassBody && ctx.scope.enclosingClass) {
      const cls = ctx.scope.enclosingClass;
      const name = uniqueName(
        'newMethod',
        new Set([...cls.methods.map((m) => m.name), ...cls.properties.map((p) => p.name)]),
      );
      return snippetAtPlan(
        ctx,
        planClassMemberInsertion(ctx, cls, 'method'),
        methodSkeletonSnippet(ctx, name),
      );
    }
    const name = uniqueName(
      'newFunction',
      new Set([...ctx.scope.visibleNames, ...ctx.declarations.topLevelNames]),
    );
    if (ctx.scope.enclosingFunction) {
      const choice = await pickOrDefault<'top' | 'nested'>(
        ui,
        [
          {
            label: 'Top-level function',
            description: `after ${ctx.scope.enclosingFunction.name || 'the current function'}`,
            value: 'top',
          },
          { label: 'Nested function', description: 'at the cursor position', value: 'nested' },
        ],
        'Where should the function go?',
      );
      if (!choice) {
        return { cancelled: true };
      }
      if (choice === 'top') {
        return insertTopLevelSnippet(ctx, functionSkeletonSnippet(ctx, name), { position: 'after' });
      }
    }
    return insertStatementSnippet(ctx, functionSkeletonSnippet(ctx, name, { async: false }));
  },
});

// ---------------------------------------------------------------------------
// Shift+F2 Create Variable
// ---------------------------------------------------------------------------

export const createVariable: CommandDefinition = defineCommand({
  id: 'codepilot.createVariable',
  title: 'Create Variable',
  category: 'core',
  description: 'Extracts the selected expression into a well-named const, or inserts a variable declaration.',
  keybinding: { key: 'shift+f2' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      return ok(80, `Extract ${describeSelection(ctx)} into a variable`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select a single expression to extract into a variable.');
    }
    if (ctx.scope.inClassBody || ctx.scope.inObjectLiteral) {
      return ok(30, ctx.scope.inClassBody ? 'Add a class property' : 'Add an object property');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(20, 'Insert a variable declaration');
  },
  async execute(ctx, ui) {
    if (ctx.selection.kind !== 'none') {
      return extractVariable(ctx);
    }
    if (ctx.scope.inClassBody || ctx.scope.inObjectLiteral) {
      return createProperty.execute(ctx, ui);
    }
    const name = uniqueName('value', ctx.scope.visibleNames);
    return insertStatementSnippet(ctx, `\${1|const,let|} \${2:${name}} = \${3:undefined}${semi(ctx)}`);
  },
});

// ---------------------------------------------------------------------------
// Shift+F3 Create Constant
// ---------------------------------------------------------------------------

export const createConstant: CommandDefinition = defineCommand({
  id: 'codepilot.createConstant',
  title: 'Create Constant',
  category: 'core',
  description:
    'Hoists the selected literal into a module-level UPPER_CASE constant (replacing duplicates), or inserts a constant declaration.',
  keybinding: { key: 'shift+f3' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const e = unwrapExpression(expr);
      const literal =
        ts.isStringLiteral(e) ||
        ts.isNumericLiteral(e) ||
        ts.isNoSubstitutionTemplateLiteral(e) ||
        ts.isArrayLiteralExpression(e) ||
        ts.isObjectLiteralExpression(e);
      return ok(literal ? 70 : 40, `Extract ${describeSelection(ctx)} into a constant`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select a literal or expression to extract into a constant.');
    }
    if (ctx.scope.kind === 'module') {
      return ok(20, 'Insert a module-level constant');
    }
    if (canInsertStatement(ctx)) {
      return ok(15, 'Insert a module-level constant after the imports');
    }
    return no(statementScopeReason(ctx));
  },
  async execute(ctx) {
    if (ctx.selection.kind !== 'none') {
      return extractConstant(ctx);
    }
    const name = uniqueName('CONSTANT_NAME', ctx.declarations.topLevelNames);
    const template = `const \${1:${name}} = \${2:value}${semi(ctx)}`;
    if (ctx.scope.kind === 'module' && ctx.currentLine.isBlank) {
      return insertStatementSnippet(ctx, template);
    }
    return insertTopLevelSnippet(ctx, template, { afterImports: true });
  },
});

// ---------------------------------------------------------------------------
// Shift+F4 Create Class
// ---------------------------------------------------------------------------

function classFromInterface(
  ctx: CodeContext,
  iface: InterfaceInfo,
  ifaceNode: ts.InterfaceDeclaration,
): CommandResult {
  const base = /^I[A-Z]/.test(iface.name) ? iface.name.slice(1) : `${iface.name}Impl`;
  const name = uniqueTypeName(ctx, base);
  const code = generateClassCode(ctx, {
    name,
    members: iface.members.map((m) => ({ name: m.name, typeText: m.typeText, optional: m.optional })),
    methods: iface.methods,
    implementsName: iface.name,
    exported: iface.isExported,
  });
  const snippet = escapeSnippet(code).replace(`class ${name}`, `class \${1:${name}}`);
  const end = ifaceNode.getEnd();
  const rest = ctx.text.slice(end);
  const suffix = rest.trim().length === 0 || /^\r?\n\s*\r?\n/.test(rest) ? '' : ctx.eol;
  const plan: InsertionPlan = { range: { start: end, end }, indent: '', prefix: ctx.eol + ctx.eol, suffix };
  return snippetAtPlan(ctx, plan, snippet, {
    message: `Created class ${name} implementing ${iface.name} with ${iface.members.length} properties`,
  });
}

export const createClass: CommandDefinition = defineCommand({
  id: 'codepilot.createClass',
  title: 'Create Class',
  category: 'core',
  description:
    'Creates a class: from a nearby interface (implementing it), from a selected object literal, or as a skeleton.',
  keybinding: { key: 'shift+f4' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const obj = ctx.selection.kind === 'none' ? undefined : getTargetObjectLiteral(ctx);
    if (obj) {
      return ok(60, 'Create a class from the selected object literal');
    }
    const near = nearbyInterface(ctx);
    if (near) {
      return ok(near.explicit ? 75 : 55, `Create a class implementing ${near.info.name}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an object literal or an interface, or clear the selection.');
    }
    if (ctx.scope.kind === 'jsx' || ctx.scope.kind === 'object' || ctx.scope.kind === 'interface') {
      return no(statementScopeReason(ctx));
    }
    return ok(20, 'Insert a class skeleton');
  },
  async execute(ctx, ui) {
    const ast = tsOf(ctx);
    const obj = ctx.selection.kind === 'none' ? undefined : getTargetObjectLiteral(ctx);
    if (obj) {
      const shape = shapeFromObjectLiteral(obj, { sf: ast.sourceFile, getChecker: ast.getChecker });
      const name = uniqueTypeName(ctx, typeNameForObject(ctx, obj, 'Model'));
      const members = shape.props.map((p) => ({
        name: p.name,
        typeText:
          p.type.kind === 'text'
            ? p.type.text
            : p.type.kind === 'array'
              ? 'unknown[]'
              : 'Record<string, unknown>',
        optional: p.optional,
      }));
      const code = generateClassCode(ctx, { name, members, exported: false });
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      return snippetAtPlan(ctx, plan, escapeSnippet(code).replace(`class ${name}`, `class \${1:${name}}`), {
        message: `Created class ${name} with ${members.length} properties inferred from the object literal`,
      });
    }
    const near = nearbyInterface(ctx);
    if (near) {
      return classFromInterface(ctx, near.info, near.node);
    }
    const interfaces = ctx.declarations.interfaces;
    if (interfaces.length && ctx.language.isTypeScript) {
      const items: PickItem<InterfaceInfo | 'empty'>[] = [
        { label: 'Empty class', description: 'skeleton with a constructor', value: 'empty' },
        ...interfaces.map((i) => ({
          label: `Implement ${i.name}`,
          description: `${i.members.length} properties`,
          value: i,
        })),
      ];
      const picked = await ui.pick(items, {
        title: 'Create Class',
        placeholder: 'Which class do you want to create?',
      });
      if (picked === undefined) {
        return { cancelled: true };
      }
      if (picked !== 'empty') {
        const node = ast.sourceFile.statements.find(
          (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === picked.name,
        );
        if (node) {
          return classFromInterface(ctx, picked, node);
        }
      }
    }
    const name = uniqueTypeName(ctx, 'NewClass');
    return insertTopLevelSnippet(ctx, classSkeletonSnippet(ctx, name, false), { position: 'after' });
  },
});

// ---------------------------------------------------------------------------
// Shift+F5 Create Interface
// ---------------------------------------------------------------------------

function interfaceFromClass(ctx: CodeContext, cls: ts.ClassDeclaration): CommandResult {
  const info = getClassInfo(cls, tsOf(ctx).sourceFile);
  const name = uniqueTypeName(ctx, `I${info.name}`);
  const props = info.properties.filter(
    (p) => !p.isStatic && p.visibility !== 'private' && p.visibility !== 'protected',
  );
  const methods = info.methods.filter(
    (m) =>
      !m.isStatic && m.visibility !== 'private' && m.visibility !== 'protected' && m.name !== 'constructor',
  );
  const lines = [
    ...props.map((p) => `\t${p.name}${p.optional ? '?' : ''}: ${p.typeText ?? 'unknown'}${semi(ctx)}`),
    ...methods.map(
      (m) =>
        `\t${m.name}(${m.parameters.map((p) => p.text).join(', ')}): ${m.returnTypeText ?? (m.isAsync ? 'Promise<void>' : 'void')}${semi(ctx)}`,
    ),
  ];
  const code = `${info.isExported ? 'export ' : ''}interface ${name} {\n${lines.join('\n')}\n}`;
  const plan = planTopLevelInsertion(ctx, { position: 'before' });
  const implementsEdit =
    cls.name && !info.implementsNames.includes(name)
      ? {
          range: {
            start: cls.heritageClauses?.[0]
              ? cls.heritageClauses[cls.heritageClauses.length - 1].getEnd()
              : cls.name.getEnd(),
            end: cls.heritageClauses?.[0]
              ? cls.heritageClauses[cls.heritageClauses.length - 1].getEnd()
              : cls.name.getEnd(),
          },
          text: info.implementsNames.length ? `, ${name}` : ` implements ${name}`,
        }
      : undefined;
  return {
    edits: [
      {
        range: plan.range,
        text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
      },
      ...(implementsEdit ? [implementsEdit] : []),
    ],
    message: `Created interface ${name} from class ${info.name}`,
  };
}

export const createInterface: CommandDefinition = defineCommand({
  id: 'codepilot.createInterface',
  title: 'Create Interface',
  category: 'core',
  description:
    'Infers an interface from a selected object literal (nested objects, arrays, optional properties) or a class; JavaScript files get a JSDoc typedef.',
  keybinding: { key: 'shift+f5', when: '!inDebugMode' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const obj = getTargetObjectLiteral(ctx);
    if (obj) {
      return ok(
        85,
        `Infer ${ctx.language.isTypeScript ? 'an interface' : 'a JSDoc typedef'} from the object literal`,
      );
    }
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isClassDeclaration(decl) && ctx.language.isTypeScript) {
      return ok(60, `Extract an interface from class ${decl.name?.text ?? ''}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an object literal (or a class) to infer an interface from.');
    }
    if (ctx.scope.kind === 'jsx') {
      return no(statementScopeReason(ctx));
    }
    return ok(20, 'Insert an interface skeleton');
  },
  async execute(ctx) {
    const obj = getTargetObjectLiteral(ctx);
    if (obj) {
      const name = uniqueTypeName(ctx, typeNameForObject(ctx, obj, 'Shape'));
      const kind = ctx.language.isTypeScript ? 'interface' : 'jsdoc';
      const emitted = generateTypeFromObjectLiteral(ctx, obj, name, kind, false);
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      const edits = [
        {
          range: plan.range,
          text: plan.prefix + renderCode(emitted.code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
        },
      ];
      const annotate = annotateVariableEdit(ctx, obj, name);
      if (annotate) {
        edits.push(annotate);
      }
      return {
        edits,
        message: `Created ${kind === 'jsdoc' ? 'typedef' : 'interface'} ${emitted.names.join(', ')}${annotate ? ' and annotated the variable' : ''}`,
      };
    }
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isClassDeclaration(decl) && ctx.language.isTypeScript) {
      return interfaceFromClass(ctx, decl);
    }
    const name = uniqueTypeName(ctx, 'NewInterface');
    if (!ctx.language.isTypeScript) {
      return insertTopLevelSnippet(
        ctx,
        `/**\n * @typedef {Object} \${1:${name}}\n * @property {\${2:string}} \${3:property}\n */`,
        { position: 'before' },
      );
    }
    return insertTopLevelSnippet(
      ctx,
      `interface \${1:${name}} {\n\t\${2:property}: \${3:string}${semi(ctx)}\n}`,
      { position: ctx.scope.kind === 'module' ? 'after' : 'before' },
    );
  },
});

// ---------------------------------------------------------------------------
// Shift+F6 Create Type
// ---------------------------------------------------------------------------

function stringLiteralUnion(expr: ts.Expression): string[] | undefined {
  const e = unwrapExpression(expr);
  if (!ts.isArrayLiteralExpression(e) || e.elements.length === 0) {
    return undefined;
  }
  const values: string[] = [];
  for (const el of e.elements) {
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
      values.push(el.text);
    } else {
      return undefined;
    }
  }
  return values;
}

export const createType: CommandDefinition = defineCommand({
  id: 'codepilot.createType',
  title: 'Create Type',
  category: 'core',
  description:
    'Creates a type alias from a selected object literal, a string array (union), an inferable expression, or converts an interface to a type.',
  keybinding: { key: 'shift+f6' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (!ctx.language.isTypeScript) {
      return no(
        'Type aliases are TypeScript-only. Use Create Interface for a JSDoc typedef in JavaScript files.',
      );
    }
    const obj = getTargetObjectLiteral(ctx);
    if (obj) {
      return ok(70, 'Infer a type alias from the object literal');
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr && stringLiteralUnion(expr)) {
      return ok(80, 'Create a string-literal union type from the array');
    }
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isInterfaceDeclaration(decl)) {
      return ok(50, `Convert interface ${decl.name.text} to a type alias`);
    }
    if (expr) {
      const type = checkerTypeText(tsOf(ctx).getChecker(), expr);
      if (type) {
        return ok(45, `Create type alias for \`${type}\``);
      }
      return no('The type of the selected expression could not be inferred.');
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an object literal, an array of strings or an expression.');
    }
    return ok(20, 'Insert a type alias skeleton');
  },
  async execute(ctx) {
    const ast = tsOf(ctx);
    const sf = ast.sourceFile;
    const sc = semi(ctx);
    const obj = getTargetObjectLiteral(ctx);
    if (obj) {
      const name = uniqueTypeName(ctx, typeNameForObject(ctx, obj, 'Shape'));
      const emitted = generateTypeFromObjectLiteral(ctx, obj, name, 'type', false);
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      const edits = [
        {
          range: plan.range,
          text: plan.prefix + renderCode(emitted.code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
        },
      ];
      const annotate = annotateVariableEdit(ctx, obj, name);
      if (annotate) {
        edits.push(annotate);
      }
      return { edits, message: `Created type ${emitted.names.join(', ')}` };
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    const union = expr ? stringLiteralUnion(expr) : undefined;
    if (expr && union) {
      const assigned = getAssignedName(expr);
      const name = uniqueTypeName(ctx, assigned ? toPascalCase(singularize(assigned)) : 'Option');
      const q = ctx.style.quote;
      const code = `type ${name} = ${union.map((v) => `${q}${v}${q}`).join(' | ')}${sc}`;
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      const edits = [
        {
          range: plan.range,
          text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
        },
      ];
      // `const roles = ['a', 'b']` → `const roles: Role[] = [...]`
      const parent = unwrapExpression(expr).parent;
      if (parent && ts.isVariableDeclaration(parent) && !parent.type && ts.isIdentifier(parent.name)) {
        edits.push({
          range: { start: parent.name.getEnd(), end: parent.name.getEnd() },
          text: `: ${name}[]`,
        });
      }
      return { edits, message: `Created union type ${name} with ${union.length} members` };
    }
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isInterfaceDeclaration(decl)) {
      const info = getInterfaceInfo(decl, sf);
      const body = ctx.text.slice(info.bodyRange.start, info.bodyRange.end);
      const heritage = info.extendsNames.length ? `${info.extendsNames.join(' & ')} & ` : '';
      const typeParams = decl.typeParameters
        ? `<${decl.typeParameters.map((p) => p.getText(sf)).join(', ')}>`
        : '';
      const code = `${info.isExported ? 'export ' : ''}type ${info.name}${typeParams} = ${heritage}{${body}}${sc}`;
      return {
        edits: [{ range: { start: decl.getStart(sf), end: decl.getEnd() }, text: code }],
        message: `Converted interface ${info.name} to a type alias`,
      };
    }
    if (expr) {
      const type = checkerTypeText(ast.getChecker(), expr);
      if (!type) {
        throw new CodePilotError('unavailable', 'The type of the selected expression could not be inferred.');
      }
      const assigned = getAssignedName(expr);
      const name = uniqueTypeName(ctx, toPascalCase(assigned ?? 'Value') + (assigned ? '' : 'Type'));
      const code = `type ${name} = ${type}${sc}`;
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      const edits = [
        {
          range: plan.range,
          text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
        },
      ];
      const parent = unwrapExpression(expr).parent;
      if (
        parent &&
        ts.isVariableDeclaration(parent) &&
        !parent.type &&
        ts.isIdentifier(parent.name) &&
        parent.initializer === expr
      ) {
        edits.push({ range: { start: parent.name.getEnd(), end: parent.name.getEnd() }, text: `: ${name}` });
      }
      return { edits, message: `Created type ${name} = ${type}` };
    }
    const name = uniqueTypeName(ctx, 'NewType');
    return insertTopLevelSnippet(ctx, `type \${1:${name}} = \${2:string}${sc}`, {
      position: ctx.scope.kind === 'module' ? 'after' : 'before',
    });
  },
});

// ---------------------------------------------------------------------------
// Shift+F7 Create Enum
// ---------------------------------------------------------------------------

function enumMembersFromValues(values: string[]): { name: string; value: string }[] {
  const used = new Set<string>();
  return values.map((v) => {
    let name = toPascalCase(v) || 'Value';
    if (!isValidIdentifier(name)) {
      name = `_${name}`;
    }
    name = uniqueName(name, used);
    used.add(name);
    return { name, value: v };
  });
}

function enumCode(
  ctx: CodeContext,
  name: string,
  members: { name: string; value: string; numeric?: boolean }[],
  exported: boolean,
): string {
  const q = ctx.style.quote;
  const sc = semi(ctx);
  const exp = exported ? 'export ' : '';
  if (ctx.language.isTypeScript) {
    const lines = members.map((m) => `\t${m.name} = ${m.numeric ? m.value : `${q}${m.value}${q}`},`);
    return `${exp}enum ${name} {\n${lines.join('\n')}\n}`;
  }
  const lines = members.map((m) => `\t${m.name}: ${m.numeric ? m.value : `${q}${m.value}${q}`},`);
  return `${exp}const ${name} = Object.freeze({\n${lines.join('\n')}\n})${sc}`;
}

export const createEnum: CommandDefinition = defineCommand({
  id: 'codepilot.createEnum',
  title: 'Create Enum',
  category: 'core',
  description:
    'Creates an enum from a selected string array, a literal-union type alias or an object literal; JavaScript files get a frozen object.',
  keybinding: { key: 'shift+f7' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr && stringLiteralUnion(expr)) {
      return ok(75, 'Create an enum from the string array');
    }
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isTypeAliasDeclaration(decl) && getUnionLiterals(decl.type)) {
      return ok(65, `Convert type ${decl.name.text} to an enum`);
    }
    const obj = ctx.selection.kind === 'none' ? undefined : getTargetObjectLiteral(ctx);
    if (
      obj &&
      obj.properties.every(
        (p) =>
          ts.isPropertyAssignment(p) &&
          (ts.isStringLiteral(p.initializer) || ts.isNumericLiteral(p.initializer)),
      )
    ) {
      return ok(60, 'Create an enum from the object literal');
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an array of strings, a literal-union type or an object of literal values.');
    }
    if (ctx.scope.kind === 'jsx' || ctx.scope.kind === 'object') {
      return no(statementScopeReason(ctx));
    }
    return ok(20, 'Insert an enum skeleton');
  },
  async execute(ctx) {
    const ast = tsOf(ctx);
    const sf = ast.sourceFile;
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    const union = expr ? stringLiteralUnion(expr) : undefined;
    if (expr && union) {
      const assigned = getAssignedName(expr);
      const name = uniqueTypeName(ctx, assigned ? toPascalCase(singularize(assigned)) : 'Option');
      const code = enumCode(ctx, name, enumMembersFromValues(union), false);
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      return {
        edits: [
          {
            range: plan.range,
            text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
          },
        ],
        message: `Created enum ${name} with ${union.length} members`,
      };
    }
    const decl = getTargetDeclaration(ctx);
    if (decl && ts.isTypeAliasDeclaration(decl)) {
      const literals = getUnionLiterals(decl.type);
      if (literals) {
        const numeric = ts.isUnionTypeNode(decl.type)
          ? decl.type.types.every((t) => ts.isLiteralTypeNode(t) && ts.isNumericLiteral(t.literal))
          : false;
        const members = enumMembersFromValues(literals).map((m) => ({ ...m, numeric }));
        const code = enumCode(
          ctx,
          decl.name.text,
          members,
          ctx.declarations.types.find((t) => t.name === decl.name.text)?.isExported ?? false,
        );
        return {
          edits: [
            {
              range: { start: decl.getStart(sf), end: decl.getEnd() },
              text: renderCode(code, ctx, lineIndentAt(ctx.text, decl.getStart(sf))),
            },
          ],
          message: `Converted type ${decl.name.text} to an enum`,
        };
      }
    }
    const obj = ctx.selection.kind === 'none' ? undefined : getTargetObjectLiteral(ctx);
    if (obj) {
      const members = obj.properties.filter(ts.isPropertyAssignment).map((p) => ({
        name: toPascalCase(p.name.getText(sf).replace(/['"]/g, '')),
        value: ts.isStringLiteral(p.initializer) ? p.initializer.text : p.initializer.getText(sf),
        numeric: ts.isNumericLiteral(p.initializer),
      }));
      const name = uniqueTypeName(ctx, typeNameForObject(ctx, obj, 'Option'));
      const code = enumCode(ctx, name, members, false);
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      return {
        edits: [
          {
            range: plan.range,
            text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
          },
        ],
        message: `Created enum ${name} with ${members.length} members`,
      };
    }
    const name = uniqueTypeName(ctx, 'NewEnum');
    const q = ctx.style.quote;
    if (ctx.language.isTypeScript) {
      return insertTopLevelSnippet(
        ctx,
        `enum \${1:${name}} {\n\t\${2:Value} = ${q}\${2/(.*)/\${1:/downcase}/}${q},\n}`,
        { position: ctx.scope.kind === 'module' ? 'after' : 'before' },
      );
    }
    return insertTopLevelSnippet(
      ctx,
      `const \${1:${name}} = Object.freeze({\n\t\${2:Value}: ${q}\${2/(.*)/\${1:/downcase}/}${q},\n})${semi(ctx)}`,
      { position: ctx.scope.kind === 'module' ? 'after' : 'before' },
    );
  },
});

// ---------------------------------------------------------------------------
// Shift+F8 Create Object
// ---------------------------------------------------------------------------

export const createObject: CommandDefinition = defineCommand({
  id: 'codepilot.createObject',
  title: 'Create Object',
  category: 'core',
  description:
    'Creates an object literal with sample values for every property of a nearby interface or type, or inserts an object skeleton.',
  keybinding: { key: 'shift+f8' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const target = targetShapeDeclaration(ctx);
    if (target && shapeFromDeclaration(target)) {
      return ok(70, `Create an object matching ${target.name}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an interface, type or its name to create a matching object.');
    }
    if (ctx.scope.inClassBody) {
      return ok(25, 'Add an object-valued property');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(20, 'Insert an object literal');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const target = targetShapeDeclaration(ctx);
    const shape = target ? shapeFromDeclaration(target) : undefined;
    if (target && shape) {
      const varName = uniqueName(
        uncapitalize(target.name),
        new Set([...ctx.scope.visibleNames, ...ctx.declarations.topLevelNames]),
      );
      const literal = objectLiteralForShape(ctx, shape, false);
      const annotation = ctx.language.isTypeScript ? `: ${target.name}` : '';
      const code = `const \${1:${varName}}${annotation} = ${escapeSnippet(literal)}${sc}`;
      const decl = getTargetDeclaration(ctx);
      if (decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl))) {
        const end = decl.getEnd();
        const rest = ctx.text.slice(end);
        const plan: InsertionPlan = {
          range: { start: end, end },
          indent: '',
          prefix: ctx.eol + ctx.eol,
          suffix: rest.trim().length === 0 || /^\r?\n\s*\r?\n/.test(rest) ? '' : ctx.eol,
        };
        return snippetAtPlan(ctx, plan, code, {
          message: `Created ${varName} with ${shape.members.filter((m) => !m.optional).length} properties from ${target.name}`,
        });
      }
      if (canInsertStatement(ctx)) {
        return insertStatementSnippet(ctx, code, { message: `Created ${varName} from ${target.name}` });
      }
      return insertTopLevelSnippet(ctx, code, { position: 'after' });
    }
    if (ctx.scope.inClassBody && ctx.scope.enclosingClass) {
      return snippetAtPlan(
        ctx,
        planClassMemberInsertion(ctx, ctx.scope.enclosingClass, 'property'),
        `\${1:options} = {\n\t\${2:key}: \${3:value},\n}${sc}`,
      );
    }
    const name = uniqueName('options', ctx.scope.visibleNames);
    return insertStatementSnippet(ctx, `const \${1:${name}} = {\n\t\${2:key}: \${3:value},\n}${sc}`);
  },
});

// ---------------------------------------------------------------------------
// Shift+F9 Create Array
// ---------------------------------------------------------------------------

export const createArray: CommandDefinition = defineCommand({
  id: 'codepilot.createArray',
  title: 'Create Array',
  category: 'core',
  description:
    'Creates a typed array for a nearby interface/type or the selected type name, or inserts an array declaration.',
  keybinding: { key: 'shift+f9' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const target = targetShapeDeclaration(ctx);
    if (target) {
      return ok(55, `Create an array of ${target.name}`);
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      return ok(35, `Wrap ${describeSelection(ctx)} in an array`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an expression or a type name.');
    }
    if (ctx.scope.inClassBody) {
      return ok(25, 'Add an array property');
    }
    if (!canInsertStatement(ctx)) {
      return no(statementScopeReason(ctx));
    }
    return ok(20, 'Insert an array declaration');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const ast = tsOf(ctx);
    const target = targetShapeDeclaration(ctx);
    if (target) {
      const varName = uniqueName(
        pluralize(uncapitalize(target.name)),
        new Set([...ctx.scope.visibleNames, ...ctx.declarations.topLevelNames]),
      );
      const annotation = ctx.language.isTypeScript ? `: ${target.name}[]` : '';
      const code = `const \${1:${varName}}${annotation} = []${sc}`;
      const decl = getTargetDeclaration(ctx);
      if (decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl))) {
        const end = decl.getEnd();
        const rest = ctx.text.slice(end);
        const plan: InsertionPlan = {
          range: { start: end, end },
          indent: '',
          prefix: ctx.eol + ctx.eol,
          suffix: rest.trim().length === 0 || /^\r?\n\s*\r?\n/.test(rest) ? '' : ctx.eol,
        };
        return snippetAtPlan(ctx, plan, code);
      }
      return canInsertStatement(ctx)
        ? insertStatementSnippet(ctx, code)
        : insertTopLevelSnippet(ctx, code, { position: 'after' });
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const text = ctx.text.slice(ctx.selection.range.start, ctx.selection.range.end);
      const stmt = ast.selectedStatements.length === 1 ? ast.selectedStatements[0] : undefined;
      if (stmt && ts.isExpressionStatement(stmt)) {
        const name = uniqueName(
          pluralize(ts.isIdentifier(expr) ? expr.text : 'item'),
          ctx.scope.visibleNames,
        );
        return {
          edits: [
            {
              range: { start: stmt.getStart(ast.sourceFile), end: stmt.getEnd() },
              text: `const ${name} = [${expr.getText(ast.sourceFile)}]${sc}`,
            },
          ],
        };
      }
      return { edits: [{ range: ctx.selection.range, text: `[${text}]` }] };
    }
    if (ctx.scope.inClassBody && ctx.scope.enclosingClass) {
      return snippetAtPlan(
        ctx,
        planClassMemberInsertion(ctx, ctx.scope.enclosingClass, 'property'),
        `\${1:items}${typePlaceholder(ctx, 2, 'string[]')} = []${sc}`,
      );
    }
    const name = uniqueName('items', ctx.scope.visibleNames);
    return insertStatementSnippet(ctx, `const \${1:${name}}${typePlaceholder(ctx, 2, 'string[]')} = []${sc}`);
  },
});

// ---------------------------------------------------------------------------
// Shift+F10 Create Constructor
// ---------------------------------------------------------------------------

export const createConstructor: CommandDefinition = defineCommand({
  id: 'codepilot.createConstructor',
  title: 'Create Constructor',
  category: 'core',
  description:
    'Generates a constructor that initialises the uninitialised properties of the enclosing class (calls super() when the class extends another).',
  keybinding: { key: 'shift+f10' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const cls = ctx.scope.enclosingClass;
    if (!cls) {
      return no('Place the cursor inside a class to create a constructor.');
    }
    if (cls.hasConstructor) {
      return no(`Class ${cls.name} already has a constructor.`);
    }
    const props = cls.properties.filter((p) => !p.isStatic && !p.hasInitializer);
    return ok(70, `Create constructor(${props.map((p) => p.name).join(', ')}) for ${cls.name}`);
  },
  async execute(ctx) {
    const cls = ctx.scope.enclosingClass;
    if (!cls) {
      throw new CodePilotError('unavailable', 'Place the cursor inside a class to create a constructor.');
    }
    const sc = semi(ctx);
    const isTs = ctx.language.isTypeScript;
    const members = membersFromProperties(cls.properties.filter((p) => !p.isStatic && !p.hasInitializer));
    const required = members.filter((m) => !m.optional);
    const optional = members.filter((m) => m.optional);
    const ordered = [...required, ...optional];
    const params = ordered
      .map((m) => (isTs ? `${m.name}${m.optional ? '?' : ''}: ${m.typeText ?? 'unknown'}` : m.name))
      .join(', ');
    const lines: string[] = [];
    let placeholder = 1;
    if (cls.extendsName) {
      lines.push(`\tsuper(\${${placeholder++}})${sc}`);
    }
    for (const m of ordered) {
      lines.push(`\tthis.${m.name} = ${m.name}${sc}`);
    }
    if (lines.length === 0) {
      lines.push('\t$0');
    } else {
      lines.push('\t$0');
    }
    const code = `constructor(${escapeSnippet(params)}) {\n${lines.join('\n')}\n}`;
    return snippetAtPlan(ctx, planClassMemberInsertion(ctx, cls, 'constructor'), code, {
      message: `Created constructor for ${cls.name} initialising ${ordered.length} propert${ordered.length === 1 ? 'y' : 'ies'}`,
    });
  },
});

// ---------------------------------------------------------------------------
// Shift+F11 Create Method
// ---------------------------------------------------------------------------

export const createMethod: CommandDefinition = defineCommand({
  id: 'codepilot.createMethod',
  title: 'Create Method',
  category: 'core',
  description: 'Adds a method to the enclosing class, or extracts the selected statements into a new method.',
  keybinding: { key: 'shift+f11', when: '!inDebugMode' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const cls = ctx.scope.enclosingClass;
    if (!cls) {
      return no('Place the cursor inside a class. Use Create Function outside of classes.');
    }
    if (ctx.selection.kind === 'statements' || ctx.selection.kind === 'expression') {
      return ok(75, `Extract ${describeSelection(ctx)} into a method of ${cls.name}`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select complete statements to extract, or clear the selection.');
    }
    return ok(50, `Add a method to ${cls.name}`);
  },
  async execute(ctx) {
    const cls = ctx.scope.enclosingClass;
    if (!cls) {
      throw new CodePilotError('unavailable', 'Place the cursor inside a class to create a method.');
    }
    if (ctx.selection.kind !== 'none') {
      return extractFunction(ctx, { asMethod: true });
    }
    const name = uniqueName(
      'newMethod',
      new Set([...cls.methods.map((m) => m.name), ...cls.properties.map((p) => p.name)]),
    );
    const allAsync = cls.methods.length > 0 && cls.methods.every((m) => m.isAsync);
    return snippetAtPlan(
      ctx,
      planClassMemberInsertion(ctx, cls, 'method'),
      methodSkeletonSnippet(ctx, name, { async: allAsync }),
    );
  },
});

// ---------------------------------------------------------------------------
// Shift+F12 Create Property
// ---------------------------------------------------------------------------

function planObjectMemberInsertion(
  ctx: CodeContext,
  obj: ts.ObjectLiteralExpression,
): { plan: InsertionPlan; needsLeadingComma: boolean } {
  const sf = tsOf(ctx).sourceFile;
  const objIndent = lineIndentAt(ctx.text, obj.getStart(sf));
  const indent = objIndent + ctx.indent.unit;
  if (ctx.currentLine.isBlank) {
    return {
      plan: {
        range: { start: ctx.currentLine.start, end: ctx.currentLine.end },
        indent,
        prefix: '',
        suffix: '',
        indentFirstLine: true,
      },
      needsLeadingComma: false,
    };
  }
  const prop =
    obj.properties.find((p) => p.getStart(sf) <= ctx.cursor && ctx.cursor <= p.getEnd()) ??
    obj.properties[obj.properties.length - 1];
  if (!prop) {
    const start = obj.getStart(sf) + 1;
    const between = ctx.text.slice(start, obj.getEnd() - 1);
    return {
      plan: {
        range: { start, end: start },
        indent,
        prefix: ctx.eol + indent,
        suffix: between.includes('\n') ? '' : ctx.eol + objIndent,
      },
      needsLeadingComma: false,
    };
  }
  let end = prop.getEnd();
  const hasComma = ctx.text[end] === ',';
  if (hasComma) {
    end += 1;
  }
  return {
    plan: {
      range: { start: end, end },
      indent,
      prefix: (hasComma ? '' : ',') + ctx.eol + indent,
      suffix: '',
    },
    needsLeadingComma: false,
  };
}

export const createProperty: CommandDefinition = defineCommand({
  id: 'codepilot.createProperty',
  title: 'Create Property',
  category: 'core',
  description:
    'Adds a property to the enclosing class, interface, type literal or object literal at the right position.',
  keybinding: { key: 'shift+f12' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    if (ctx.selection.kind !== 'none') {
      return no('Clear the selection to add a property.');
    }
    if (ctx.scope.inObjectLiteral) {
      return ok(55, 'Add a property to the object literal');
    }
    if (ctx.scope.inInterfaceBody && ctx.scope.enclosingInterface) {
      return ok(60, `Add a property to interface ${ctx.scope.enclosingInterface.name}`);
    }
    if (ctx.scope.enclosingClass && ctx.scope.inClassBody) {
      return ok(60, `Add a property to class ${ctx.scope.enclosingClass.name}`);
    }
    if (ctx.scope.enclosingClass) {
      return ok(35, `Add a property to class ${ctx.scope.enclosingClass.name}`);
    }
    return no('Place the cursor inside a class, interface or object literal to add a property.');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const ast = tsOf(ctx);
    if (ctx.scope.inObjectLiteral) {
      let obj: ts.Node | undefined = ast.nodeAtCursor;
      while (obj && !ts.isObjectLiteralExpression(obj)) {
        obj = obj.parent;
      }
      if (obj && ts.isObjectLiteralExpression(obj)) {
        const { plan } = planObjectMemberInsertion(ctx, obj);
        return snippetAtPlan(ctx, plan, `\${1:key}: \${2:value},`);
      }
    }
    if (ctx.scope.inInterfaceBody && ctx.scope.enclosingInterface) {
      const iface = ctx.scope.enclosingInterface;
      const plan = planInterfaceMemberInsertion(ctx, iface.bodyRange, iface.range.start);
      return snippetAtPlan(ctx, plan, `\${1:property}: \${2:string}${sc}`);
    }
    if (ctx.scope.enclosingClass) {
      const cls = ctx.scope.enclosingClass;
      const plan = planClassMemberInsertion(ctx, cls, 'property');
      const name = uniqueName('property', new Set(cls.properties.map((p) => p.name)));
      if (ctx.language.isTypeScript) {
        return snippetAtPlan(
          ctx,
          plan,
          `\${1|private ,public ,protected ,readonly ,|}\${2:${name}}: \${3:string}${sc}`,
        );
      }
      return snippetAtPlan(ctx, plan, `\${1:${name}} = \${2:undefined}${sc}`);
    }
    throw new CodePilotError(
      'unavailable',
      'Place the cursor inside a class, interface or object literal to add a property.',
    );
  },
});

export const coreCommands: CommandDefinition[] = [
  createFunction,
  createVariable,
  createConstant,
  createClass,
  createInterface,
  createType,
  createEnum,
  createObject,
  createArray,
  createConstructor,
  createMethod,
  createProperty,
];
