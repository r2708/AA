import * as ts from 'typescript';
import type { CodeContext } from '../types/context';
import {
  getClassInfo,
  getFunctionInfo,
  getInterfaceInfo,
  isFunctionLikeNode,
  type FunctionLikeNode,
} from '../analyzer/astAnalyzer';
import { containsKind } from '../analyzer/astAnalyzer';
import { tsOf } from '../languages/typescript/tsContext';
import { checkerTypeText } from '../analyzer/typeInference';
import { escapeSnippet } from './codeWriter';

function summaryFor(name: string, kind: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/);
  if (kind === 'function' || kind === 'method') {
    const verbs: Record<string, string> = {
      get: 'Gets',
      set: 'Sets',
      is: 'Checks whether',
      has: 'Checks whether it has',
      create: 'Creates',
      build: 'Builds',
      fetch: 'Fetches',
      load: 'Loads',
      calculate: 'Calculates',
      compute: 'Computes',
      handle: 'Handles',
      update: 'Updates',
      delete: 'Deletes',
      remove: 'Removes',
      find: 'Finds',
      parse: 'Parses',
      format: 'Formats',
      validate: 'Validates',
      render: 'Renders',
      use: 'Hook that provides',
    };
    const verb = verbs[words[0]];
    if (verb) {
      return `${verb} ${words.slice(1).join(' ')}`.trim() + '.';
    }
    return `${name.charAt(0).toUpperCase()}${name.slice(1)}.`;
  }
  return `Represents ${words.join(' ')}.`;
}

/**
 * JSDoc snippet for the declaration node. TypeScript files omit `{type}` braces
 * (types are already in the signature), JavaScript files include inferred types.
 */
export function jsDocSnippetFor(ctx: CodeContext, node: ts.Node): string | undefined {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const isTs = ctx.language.isTypeScript;
  let placeholder = 1;
  const lines: string[] = [];

  let fn: FunctionLikeNode | undefined;
  if (isFunctionLikeNode(node)) {
    fn = node;
  } else if (ts.isVariableStatement(node)) {
    const init = node.declarationList.declarations[0]?.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      fn = init;
    }
  }

  if (fn) {
    const info = getFunctionInfo(fn, sf);
    lines.push(`\${${placeholder++}:${escapeSnippet(summaryFor(info.name || 'function', 'function'))}}`);
    for (const p of fn.parameters) {
      const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf);
      const type = p.type ? p.type.getText(sf) : (checkerTypeText(ast.getChecker(), p.name) ?? '*');
      const typePart = isTs ? '' : `{${escapeSnippet(type)}} `;
      const displayName = p.initializer && !isTs ? `[${name}]` : name;
      lines.push(`@param ${typePart}${escapeSnippet(displayName)} - \${${placeholder++}:description}`);
    }
    const returnsValue = fn.body
      ? ts.isBlock(fn.body)
        ? containsKind(fn.body, (n) => ts.isReturnStatement(n) && !!n.expression)
        : true
      : false;
    if (returnsValue || fn.type) {
      let type = fn.type ? fn.type.getText(sf) : '*';
      if (!fn.type && info.isAsync && !isTs) {
        type = 'Promise<*>';
      }
      const typePart = isTs ? '' : `{${escapeSnippet(type)}} `;
      lines.push(`@returns ${typePart}\${${placeholder++}:description}`);
    }
    if (fn.body && containsKind(fn.body, (n) => ts.isThrowStatement(n))) {
      lines.push(`@throws {\${${placeholder++}:Error}} \${${placeholder++}:when}`);
    }
  } else if (ts.isClassDeclaration(node)) {
    const info = getClassInfo(node, sf);
    lines.push(`\${${placeholder++}:${escapeSnippet(summaryFor(info.name || 'class', 'class'))}}`);
    if (info.extendsName) {
      lines.push(`@extends ${escapeSnippet(info.extendsName)}`);
    }
  } else if (ts.isInterfaceDeclaration(node)) {
    const info = getInterfaceInfo(node, sf);
    lines.push(`\${${placeholder++}:${escapeSnippet(summaryFor(info.name, 'interface'))}}`);
  } else if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
    lines.push(`\${${placeholder++}:${escapeSnippet(summaryFor(node.name.text, 'type'))}}`);
  } else if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    const name = decl && ts.isIdentifier(decl.name) ? decl.name.text : 'value';
    lines.push(`\${${placeholder++}:${escapeSnippet(summaryFor(name, 'variable'))}}`);
    if (!isTs) {
      const type = decl?.type
        ? decl.type.getText(sf)
        : (checkerTypeText(ast.getChecker(), decl?.name ?? node) ?? '*');
      lines.push(`@type {${escapeSnippet(type)}}`);
    }
  } else if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
    lines.push(`\${${placeholder++}:description}`);
  } else {
    return undefined;
  }
  if (lines.length === 1) {
    return `/** ${lines[0]} */`;
  }
  return `/**\n * ${lines.join('\n * ')}\n */`;
}
