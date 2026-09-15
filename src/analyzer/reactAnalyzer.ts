import * as ts from 'typescript';
import type { ComponentInfo, Declarations, LanguageInfo, ReactInfo } from '../types/context';
import {
  containsJsx,
  containsKind,
  getEnclosingJsxElement,
  getFunctionInfo,
  getJsxTagName,
  hookNameOf,
  isFunctionLikeNode,
  isHookCall,
  isPascalCase,
  type FunctionLikeNode,
} from './astAnalyzer';
import { nameFromFileName } from './naming';

function usesHooks(fn: ts.Node): boolean {
  return containsKind(fn, isHookCall, false);
}

function collectHooks(fn: ts.Node): string[] {
  const hooks: string[] = [];
  const visit = (n: ts.Node): void => {
    if (isHookCall(n)) {
      const name = hookNameOf(n);
      if (!hooks.includes(name)) {
        hooks.push(name);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return hooks;
}

function isComponentCandidate(fn: FunctionLikeNode, name: string | undefined, lang: LanguageInfo): boolean {
  if (!name || !isPascalCase(name)) {
    return false;
  }
  return containsJsx(fn) || usesHooks(fn) || lang.isJsx;
}

export function buildComponentInfo(
  fn: FunctionLikeNode,
  sf: ts.SourceFile,
  nameOverride?: string,
): ComponentInfo {
  const base = getFunctionInfo(fn, sf);
  const firstParam = fn.parameters[0];
  let propsParamName: string | undefined;
  const destructuredProps: string[] = [];
  if (firstParam) {
    if (ts.isIdentifier(firstParam.name)) {
      propsParamName = firstParam.name.text;
    } else if (ts.isObjectBindingPattern(firstParam.name)) {
      for (const el of firstParam.name.elements) {
        const prop = el.propertyName ?? el.name;
        if (ts.isIdentifier(prop)) {
          destructuredProps.push(prop.text);
        }
      }
    }
  }
  const propsAccessed: string[] = [];
  if (propsParamName && fn.body) {
    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === propsParamName
      ) {
        if (!propsAccessed.includes(n.name.text)) {
          propsAccessed.push(n.name.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  }
  let hookInsertOffset: number | undefined;
  if (fn.body && ts.isBlock(fn.body)) {
    hookInsertOffset = fn.body.getStart(sf) + 1;
    for (const stmt of fn.body.statements) {
      const isHookStatement =
        (ts.isVariableStatement(stmt) &&
          stmt.declarationList.declarations.some((d) => d.initializer && isHookCall(d.initializer))) ||
        (ts.isExpressionStatement(stmt) && isHookCall(stmt.expression));
      if (isHookStatement) {
        hookInsertOffset = stmt.getEnd();
      }
    }
  }
  return {
    ...base,
    name: nameOverride ?? base.name,
    kind: 'component',
    propsParamName,
    propsTypeText: firstParam?.type ? firstParam.type.getText(sf) : undefined,
    destructuredProps,
    propsAccessed,
    hooksUsed: collectHooks(fn),
    hookInsertOffset,
  };
}

export function analyzeReact(
  sf: ts.SourceFile,
  decls: Declarations,
  lang: LanguageInfo,
  nodeAtCursor: ts.Node,
  fileName: string,
): ReactInfo {
  const reactImport = decls.imports.find((i) => i.moduleSpecifier === 'react');
  const hasReactImport = !!reactImport;
  const fileHasJsx = containsJsx(sf);
  const fileHooks = collectHooks(sf);
  const isReact = hasReactImport || lang.isJsx || fileHasJsx || fileHooks.length > 0;

  const components: ComponentInfo[] = [];
  if (isReact) {
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt)) {
        const name = stmt.name?.text ?? (containsJsx(stmt) ? nameFromFileName(fileName) : undefined);
        if (name && isComponentCandidate(stmt, name, lang)) {
          components.push(buildComponentInfo(stmt, sf, name));
        }
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          const init = d.initializer;
          if (
            init &&
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            ts.isIdentifier(d.name)
          ) {
            if (isComponentCandidate(init, d.name.text, lang)) {
              components.push(buildComponentInfo(init, sf, d.name.text));
            }
          }
        }
      } else if (ts.isExportAssignment(stmt)) {
        const expr = stmt.expression;
        if ((ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) && containsJsx(expr)) {
          components.push(buildComponentInfo(expr, sf, nameFromFileName(fileName)));
        }
      }
    }
  }

  let enclosingComponent: ComponentInfo | undefined;
  if (isReact) {
    let current: ts.Node | undefined = nodeAtCursor;
    while (current && !ts.isSourceFile(current)) {
      if (isFunctionLikeNode(current)) {
        const info = getFunctionInfo(current, sf);
        const known = components.find((c) => c.range.start === info.range.start);
        if (known) {
          enclosingComponent = known;
          break;
        }
        if (isPascalCase(info.name) && (containsJsx(current) || usesHooks(current))) {
          enclosingComponent = buildComponentInfo(current, sf);
          break;
        }
      }
      current = current.parent;
    }
  }

  const jsxEl = getEnclosingJsxElement(nodeAtCursor);
  const inJsx =
    !!jsxEl || (!!nodeAtCursor && (ts.isJsxAttribute(nodeAtCursor) || ts.isJsxText(nodeAtCursor)));
  return {
    isReact,
    hasReactImport,
    reactImport,
    components,
    enclosingComponent,
    hooksUsed: fileHooks,
    inJsx,
    jsxTagName: jsxEl ? getJsxTagName(jsxEl, sf) : undefined,
  };
}
