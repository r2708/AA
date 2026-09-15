/**
 * AST analysis for JavaScript/TypeScript built on the TypeScript compiler API.
 * Pure functions only: no VS Code dependency.
 */
import * as ts from 'typescript';
import type {
  ClassInfo,
  Declarations,
  DiagnosticInfo,
  EnumInfo,
  FunctionInfo,
  ImportInfo,
  InterfaceInfo,
  LanguageInfo,
  MethodInfo,
  ParameterInfo,
  PropertyInfo,
  Range,
  TypeAliasInfo,
  VariableInfo,
} from '../types/context';

export type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export function getScriptKind(lang: LanguageInfo): ts.ScriptKind {
  if (lang.isTypeScript) {
    return lang.isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  }
  return lang.isJsx ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}

export function parseSource(text: string, fileName: string, lang: LanguageInfo): ts.SourceFile {
  const name = fileName && fileName.length > 0 ? fileName : lang.isTypeScript ? 'file.ts' : 'file.js';
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, getScriptKind(lang));
}

export function getSyntacticDiagnostics(sf: ts.SourceFile): DiagnosticInfo[] {
  const internal = sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] };
  const diags = internal.parseDiagnostics ?? [];
  return diags.map((d) => ({
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    range: { start: d.start, end: d.start + d.length },
  }));
}

export function rangeOf(node: ts.Node, sf: ts.SourceFile): Range {
  return { start: node.getStart(sf), end: node.getEnd() };
}

// ---------------------------------------------------------------------------
// Node lookup
// ---------------------------------------------------------------------------

/** Deepest node whose (trivia-less) span contains `offset`. */
export function findNodeAtOffset(sf: ts.SourceFile, offset: number): ts.Node {
  let best: ts.Node = sf;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      return;
    }
    const start = node.getStart(sf);
    if (start <= offset && offset <= node.getEnd()) {
      best = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return best;
}

/** Smallest node whose span covers [start, end]. */
export function findCoveringNode(sf: ts.SourceFile, start: number, end: number): ts.Node {
  let best: ts.Node = sf;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) {
      return;
    }
    if (node.getStart(sf) <= start && end <= node.getEnd()) {
      best = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return best;
}

function unwrapStatementLike(node: ts.Node): ts.Node[] {
  const candidates: ts.Node[] = [node];
  if (ts.isExpressionStatement(node)) {
    candidates.push(node.expression);
  }
  if (ts.isParenthesizedExpression(node)) {
    candidates.push(node.expression);
  }
  return candidates;
}

/**
 * Returns the node whose span matches [start, end] exactly (ignoring a trailing semicolon),
 * or undefined when the selection does not align with a syntax node.
 */
export function findExactNode(sf: ts.SourceFile, start: number, end: number): ts.Node | undefined {
  const text = sf.text;
  const covering = findCoveringNode(sf, start, end);
  const matches = (node: ts.Node): boolean => {
    const s = node.getStart(sf);
    const e = node.getEnd();
    if (s !== start) {
      return false;
    }
    if (e === end) {
      return true;
    }
    // Selection excludes the trailing semicolon of a statement.
    if (e === end + 1 && text[end] === ';') {
      return true;
    }
    // Selection includes a semicolon that is not part of the expression node.
    if (e === end - 1 && text[end - 1] === ';') {
      return true;
    }
    return false;
  };
  for (const c of unwrapStatementLike(covering)) {
    if (matches(c)) {
      return c;
    }
  }
  // A variable statement with a single declaration: `const x = 1` (selection without `;`).
  return undefined;
}

function statementsOf(node: ts.Node): ts.NodeArray<ts.Statement> | undefined {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return node.statements;
  }
  return undefined;
}

const MODIFIER_WORDS = new Set(['export', 'default', 'async', 'declare', 'abstract', 'const']);

/** True when `start` lies after the modifiers of a declaration (selection like `[[interface A {}]]` after `export `). */
function startsAfterModifiers(stmt: ts.Statement, start: number, sf: ts.SourceFile): boolean {
  const stmtStart = stmt.getStart(sf);
  if (stmtStart >= start) {
    return false;
  }
  const prefix = sf.text.slice(stmtStart, start).trim();
  if (!prefix) {
    return false;
  }
  return prefix.split(/\s+/).every((w) => MODIFIER_WORDS.has(w));
}

function isOnlyTriviaText(text: string): boolean {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return /^\s*$/.test(stripped);
}

/**
 * Returns the whole statements contained in [start, end] when the range covers
 * complete statements (plus whitespace/comments) of a single statement list.
 */
export function getStatementsInRange(sf: ts.SourceFile, start: number, end: number): ts.Statement[] {
  const covering = findCoveringNode(sf, start, end);
  let node: ts.Node | undefined = covering;
  while (node) {
    const list = statementsOf(node);
    if (list) {
      const selected = list.filter(
        (s) =>
          (s.getStart(sf) >= start || startsAfterModifiers(s, start, sf)) &&
          (s.getEnd() <= end || (s.getEnd() === end + 1 && sf.text[end] === ';')),
      );
      if (selected.length > 0) {
        const before = sf.text.slice(
          Math.min(start, selected[0].getStart(sf)),
          Math.max(start, selected[0].getStart(sf)),
        );
        const after = sf.text.slice(Math.min(selected[selected.length - 1].getEnd(), end), end);
        const beforeOk =
          isOnlyTriviaText(before) ||
          before
            .trim()
            .split(/\s+/)
            .every((w) => MODIFIER_WORDS.has(w));
        if (beforeOk && isOnlyTriviaText(after)) {
          return selected;
        }
      }
    }
    node = node.parent;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Enclosing structures
// ---------------------------------------------------------------------------

export function isFunctionLikeNode(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

export function findAncestor<T extends ts.Node>(
  node: ts.Node | undefined,
  predicate: (n: ts.Node) => n is T,
  inclusive = true,
): T | undefined {
  let current: ts.Node | undefined = inclusive ? node : node?.parent;
  while (current) {
    if (predicate(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

export function getEnclosingFunction(node: ts.Node): FunctionLikeNode | undefined {
  return findAncestor(node, isFunctionLikeNode);
}

export function getEnclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  return findAncestor(node, ts.isClassLike);
}

export function isStatementContainerChild(node: ts.Node): boolean {
  return !!node.parent && statementsOf(node.parent) !== undefined;
}

/** Innermost statement (member of a statement list) containing the node. */
export function getEnclosingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (isStatementContainerChild(current)) {
      return current as ts.Statement;
    }
    current = current.parent;
  }
  return undefined;
}

export function getTopLevelStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current && current.parent && !ts.isSourceFile(current.parent)) {
    current = current.parent;
  }
  return current && current.parent && ts.isSourceFile(current.parent) ? (current as ts.Statement) : undefined;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === kind);
}

export function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

export function isDefaultExported(node: ts.Node): boolean {
  return isExported(node) && hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

export function getFunctionName(fn: FunctionLikeNode): string | undefined {
  if (ts.isConstructorDeclaration(fn)) {
    return 'constructor';
  }
  if (
    fn.name &&
    (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name) || ts.isPrivateIdentifier(fn.name))
  ) {
    return fn.name.text;
  }
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

export function isAsyncNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

// ---------------------------------------------------------------------------
// Symbol information extraction
// ---------------------------------------------------------------------------

export function getParameterInfo(param: ts.ParameterDeclaration, sf: ts.SourceFile): ParameterInfo {
  return {
    name: ts.isIdentifier(param.name) ? param.name.text : param.name.getText(sf),
    typeText: param.type ? param.type.getText(sf) : undefined,
    optional: !!param.questionToken,
    hasDefault: !!param.initializer,
    isRest: !!param.dotDotDotToken,
    text: param.getText(sf),
  };
}

export function getFunctionInfo(fn: FunctionLikeNode, sf: ts.SourceFile): FunctionInfo {
  const body = fn.body;
  const isArrow = ts.isArrowFunction(fn);
  const hasExpressionBody = isArrow && !!body && !ts.isBlock(body);
  const declarationNode: ts.Node =
    (isArrow || ts.isFunctionExpression(fn)) && fn.parent && ts.isVariableDeclaration(fn.parent)
      ? (fn.parent.parent.parent ?? fn)
      : fn;
  const exportedNode = ts.isVariableStatement(declarationNode) ? declarationNode : fn;
  return {
    name: getFunctionName(fn) ?? '',
    kind: ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn) ? 'method' : 'function',
    range: rangeOf(fn, sf),
    isExported: isExported(exportedNode),
    isDefaultExport: isDefaultExported(exportedNode),
    parameters: fn.parameters.map((p) => getParameterInfo(p, sf)),
    returnTypeText: fn.type ? fn.type.getText(sf) : undefined,
    isAsync: isAsyncNode(fn),
    isGenerator: !!(fn as ts.FunctionDeclaration).asteriskToken,
    isArrow,
    bodyRange: body
      ? ts.isBlock(body)
        ? { start: body.getStart(sf) + 1, end: body.getEnd() - 1 }
        : rangeOf(body, sf)
      : undefined,
    hasExpressionBody,
  };
}

function getVisibility(node: ts.Node): 'public' | 'private' | 'protected' | undefined {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
    return 'private';
  }
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) {
    return 'protected';
  }
  if (hasModifier(node, ts.SyntaxKind.PublicKeyword)) {
    return 'public';
  }
  return undefined;
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string {
  if (!name) {
    return '';
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return name.getText(sf);
}

export function getPropertyInfo(
  member: ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration,
  sf: ts.SourceFile,
): PropertyInfo {
  const initializer = ts.isPropertySignature(member) ? undefined : member.initializer;
  return {
    name: propertyName(member.name, sf),
    typeText: member.type ? member.type.getText(sf) : undefined,
    optional: !!member.questionToken,
    hasInitializer: !!initializer,
    initializerText: initializer ? initializer.getText(sf) : undefined,
    range: rangeOf(member, sf),
    isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword),
    readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
    visibility: getVisibility(member),
  };
}

function getMethodInfo(member: ts.MethodDeclaration | ts.MethodSignature, sf: ts.SourceFile): MethodInfo {
  const base: FunctionInfo = ts.isMethodDeclaration(member)
    ? getFunctionInfo(member, sf)
    : {
        name: propertyName(member.name, sf),
        kind: 'method',
        range: rangeOf(member, sf),
        isExported: false,
        parameters: member.parameters.map((p) => getParameterInfo(p, sf)),
        returnTypeText: member.type ? member.type.getText(sf) : undefined,
        isAsync: false,
        isGenerator: false,
        isArrow: false,
        hasExpressionBody: false,
      };
  return {
    ...base,
    name: propertyName(member.name, sf),
    isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword),
    visibility: getVisibility(member),
  };
}

export function getClassInfo(cls: ts.ClassLikeDeclaration, sf: ts.SourceFile): ClassInfo {
  const properties: PropertyInfo[] = [];
  const methods: MethodInfo[] = [];
  let constructorRange: Range | undefined;
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member)) {
      properties.push(getPropertyInfo(member, sf));
    } else if (ts.isMethodDeclaration(member)) {
      methods.push(getMethodInfo(member, sf));
    } else if (ts.isConstructorDeclaration(member)) {
      constructorRange = rangeOf(member, sf);
      // TypeScript parameter properties (`constructor(private id: string)`)
      for (const p of member.parameters) {
        if (
          hasModifier(p, ts.SyntaxKind.PublicKeyword) ||
          hasModifier(p, ts.SyntaxKind.PrivateKeyword) ||
          hasModifier(p, ts.SyntaxKind.ProtectedKeyword) ||
          hasModifier(p, ts.SyntaxKind.ReadonlyKeyword)
        ) {
          properties.push({ ...getPropertyInfo(p, sf), hasInitializer: true });
        }
      }
    }
  }
  let extendsName: string | undefined;
  const implementsNames: string[] = [];
  for (const clause of cls.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        extendsName = type.expression.getText(sf);
      } else {
        implementsNames.push(type.getText(sf));
      }
    }
  }
  const openBrace = cls.members.pos; // position right after `{`
  const closeBrace = cls.getEnd() - 1;
  return {
    name: cls.name?.text ?? '',
    kind: 'class',
    range: rangeOf(cls, sf),
    isExported: isExported(cls),
    isDefaultExport: isDefaultExported(cls),
    properties,
    methods,
    hasConstructor: !!constructorRange,
    constructorRange,
    extendsName,
    implementsNames,
    bodyRange: { start: openBrace, end: closeBrace },
    isAbstract: hasModifier(cls, ts.SyntaxKind.AbstractKeyword),
  };
}

export function getInterfaceInfo(decl: ts.InterfaceDeclaration, sf: ts.SourceFile): InterfaceInfo {
  const members: PropertyInfo[] = [];
  const methods: MethodInfo[] = [];
  for (const m of decl.members) {
    if (ts.isPropertySignature(m)) {
      members.push(getPropertyInfo(m, sf));
    } else if (ts.isMethodSignature(m)) {
      methods.push(getMethodInfo(m, sf));
    }
  }
  const extendsNames: string[] = [];
  for (const clause of decl.heritageClauses ?? []) {
    for (const type of clause.types) {
      extendsNames.push(type.getText(sf));
    }
  }
  return {
    name: decl.name.text,
    kind: 'interface',
    range: rangeOf(decl, sf),
    isExported: isExported(decl),
    isDefaultExport: isDefaultExported(decl),
    members,
    methods,
    extendsNames,
    bodyRange: { start: decl.members.pos, end: decl.getEnd() - 1 },
  };
}

export function getTypeLiteralMembers(node: ts.TypeNode, sf: ts.SourceFile): PropertyInfo[] | undefined {
  if (!ts.isTypeLiteralNode(node)) {
    return undefined;
  }
  return node.members.filter(ts.isPropertySignature).map((m) => getPropertyInfo(m, sf));
}

export function getUnionLiterals(node: ts.TypeNode): string[] | undefined {
  if (ts.isLiteralTypeNode(node) && (ts.isStringLiteral(node.literal) || ts.isNumericLiteral(node.literal))) {
    return [node.literal.text];
  }
  if (!ts.isUnionTypeNode(node)) {
    return undefined;
  }
  const values: string[] = [];
  for (const t of node.types) {
    if (ts.isLiteralTypeNode(t) && (ts.isStringLiteral(t.literal) || ts.isNumericLiteral(t.literal))) {
      values.push(t.literal.text);
    } else {
      return undefined;
    }
  }
  return values;
}

export function getTypeAliasInfo(decl: ts.TypeAliasDeclaration, sf: ts.SourceFile): TypeAliasInfo {
  return {
    name: decl.name.text,
    kind: 'type',
    range: rangeOf(decl, sf),
    isExported: isExported(decl),
    typeText: decl.type.getText(sf),
    members: getTypeLiteralMembers(decl.type, sf),
    unionLiterals: getUnionLiterals(decl.type),
  };
}

export function getEnumInfo(decl: ts.EnumDeclaration, sf: ts.SourceFile): EnumInfo {
  return {
    name: decl.name.text,
    kind: 'enum',
    range: rangeOf(decl, sf),
    isExported: isExported(decl),
    members: decl.members.map((m) => ({
      name: propertyName(m.name, sf),
      valueText: m.initializer ? m.initializer.getText(sf) : undefined,
    })),
    isConst: hasModifier(decl, ts.SyntaxKind.ConstKeyword),
  };
}

export function getImportInfo(decl: ts.ImportDeclaration, sf: ts.SourceFile): ImportInfo {
  const moduleSpecifier = ts.isStringLiteral(decl.moduleSpecifier)
    ? decl.moduleSpecifier.text
    : decl.moduleSpecifier.getText(sf);
  const info: ImportInfo = {
    moduleSpecifier,
    namedImports: [],
    isTypeOnly: !!decl.importClause?.isTypeOnly,
    isSideEffectOnly: !decl.importClause,
    range: rangeOf(decl, sf),
  };
  const clause = decl.importClause;
  if (clause) {
    if (clause.name) {
      info.defaultImport = clause.name.text;
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        info.namespaceImport = clause.namedBindings.name.text;
      } else {
        for (const el of clause.namedBindings.elements) {
          info.namedImports.push({
            name: el.propertyName ? el.propertyName.text : el.name.text,
            alias: el.propertyName ? el.name.text : undefined,
            isType: el.isTypeOnly,
          });
        }
      }
    }
  }
  return info;
}

function classifyInitializer(init: ts.Expression | undefined): VariableInfo['initializerKind'] {
  if (!init) {
    return undefined;
  }
  if (ts.isArrayLiteralExpression(init)) {
    return 'array';
  }
  if (ts.isObjectLiteralExpression(init)) {
    return 'object';
  }
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return 'function';
  }
  if (ts.isCallExpression(init) || ts.isAwaitExpression(init) || ts.isNewExpression(init)) {
    return 'call';
  }
  if (
    ts.isLiteralExpression(init) ||
    init.kind === ts.SyntaxKind.TrueKeyword ||
    init.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return 'literal';
  }
  return 'other';
}

function declarationKindOf(list: ts.VariableDeclarationList): 'const' | 'let' | 'var' {
  if (list.flags & ts.NodeFlags.Const) {
    return 'const';
  }
  if (list.flags & ts.NodeFlags.Let) {
    return 'let';
  }
  return 'var';
}

export function collectBindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
  } else {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) {
        collectBindingNames(el.name, out);
      }
    }
  }
  return out;
}

export function getVariableInfos(
  stmt: ts.VariableStatement,
  sf: ts.SourceFile,
  isTopLevel: boolean,
): VariableInfo[] {
  const kind = declarationKindOf(stmt.declarationList);
  const result: VariableInfo[] = [];
  for (const decl of stmt.declarationList.declarations) {
    for (const name of collectBindingNames(decl.name)) {
      result.push({
        name,
        kind: 'variable',
        range: rangeOf(stmt, sf),
        isExported: isExported(stmt),
        declarationKind: kind,
        typeText: decl.type ? decl.type.getText(sf) : undefined,
        initializerText: decl.initializer ? decl.initializer.getText(sf) : undefined,
        initializerKind: classifyInitializer(decl.initializer),
        isTopLevel,
      });
    }
  }
  return result;
}

/** Collects declarations (top-level plus nested functions/classes for lookup). */
export function collectDeclarations(sf: ts.SourceFile): Declarations {
  const decls: Declarations = {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    interfaces: [],
    types: [],
    enums: [],
    variables: [],
    topLevelNames: new Set<string>(),
  };
  const addName = (name: string | undefined): void => {
    if (name) {
      decls.topLevelNames.add(name);
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const info = getImportInfo(stmt, sf);
      decls.imports.push(info);
      addName(info.defaultImport);
      addName(info.namespaceImport);
      info.namedImports.forEach((n) => addName(n.alias ?? n.name));
    } else if (ts.isFunctionDeclaration(stmt)) {
      const info = getFunctionInfo(stmt, sf);
      decls.functions.push(info);
      addName(info.name);
      if (info.isExported) {
        decls.exports.push({ name: info.name, isDefault: !!info.isDefaultExport, range: info.range });
      }
    } else if (ts.isClassDeclaration(stmt)) {
      const info = getClassInfo(stmt, sf);
      decls.classes.push(info);
      addName(info.name);
      if (info.isExported) {
        decls.exports.push({ name: info.name, isDefault: !!info.isDefaultExport, range: info.range });
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      const info = getInterfaceInfo(stmt, sf);
      decls.interfaces.push(info);
      addName(info.name);
      if (info.isExported) {
        decls.exports.push({ name: info.name, isDefault: false, range: info.range });
      }
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      const info = getTypeAliasInfo(stmt, sf);
      decls.types.push(info);
      addName(info.name);
      if (info.isExported) {
        decls.exports.push({ name: info.name, isDefault: false, range: info.range });
      }
    } else if (ts.isEnumDeclaration(stmt)) {
      const info = getEnumInfo(stmt, sf);
      decls.enums.push(info);
      addName(info.name);
      if (info.isExported) {
        decls.exports.push({ name: info.name, isDefault: false, range: info.range });
      }
    } else if (ts.isVariableStatement(stmt)) {
      const infos = getVariableInfos(stmt, sf, true);
      for (const v of infos) {
        decls.variables.push(v);
        addName(v.name);
        if (v.isExported) {
          decls.exports.push({ name: v.name, isDefault: false, range: v.range });
        }
      }
      // Arrow functions assigned to variables are treated as functions as well.
      for (const d of stmt.declarationList.declarations) {
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          decls.functions.push(getFunctionInfo(d.initializer, sf));
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      decls.exports.push({
        name: stmt.expression.getText(sf),
        isDefault: !stmt.isExportEquals,
        range: rangeOf(stmt, sf),
      });
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          decls.exports.push({ name: el.name.text, isDefault: false, range: rangeOf(stmt, sf) });
        }
      } else {
        decls.exports.push({ name: '*', isDefault: false, range: rangeOf(stmt, sf) });
      }
    }
  }
  return decls;
}

// ---------------------------------------------------------------------------
// Identifier analysis
// ---------------------------------------------------------------------------

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isEnumMember(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isFunctionExpression(p)) &&
    p.name === id
  ) {
    return true;
  }
  if (ts.isBindingElement(p) && p.name === id) {
    return true;
  }
  return false;
}

/** True for identifiers that reference a value (not property names, labels, declaration names or types). */
export function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) {
    return false;
  }
  if (isDeclarationName(id)) {
    return false;
  }
  if (ts.isPropertyAccessExpression(p) && p.name === id) {
    return false;
  }
  if (ts.isPropertyAssignment(p) && p.name === id) {
    return false;
  }
  if (ts.isBindingElement(p) && p.propertyName === id) {
    return false;
  }
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) {
    return false;
  }
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) {
    return false;
  }
  if (ts.isJsxAttribute(p) && p.name === id) {
    return false;
  }
  if (ts.isJsxOpeningLikeElement(p) || ts.isJsxClosingElement(p)) {
    // Lowercase tags are intrinsic elements, not variables.
    return /^[A-Z]/.test(id.text);
  }
  if (ts.isPropertySignature(p) || ts.isMethodSignature(p)) {
    return false;
  }
  return true;
}

/** Identifiers referenced as values inside `root`, keyed by name (first occurrence order). */
export function collectValueReferences(root: ts.Node): Map<string, ts.Identifier[]> {
  const refs = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const list = refs.get(node.text) ?? [];
      list.push(node);
      refs.set(node.text, list);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const list = refs.get(node.name.text) ?? [];
      list.push(node.name);
      refs.set(node.name.text, list);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return refs;
}

/** Names declared anywhere inside `root` (variables, functions, classes, params, imports...). */
export function collectDeclaredNames(root: ts.Node, out = new Set<string>()): Set<string> {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name).forEach((n) => out.add(n));
    } else if (ts.isBindingElement(node)) {
      collectBindingNames(node.name).forEach((n) => out.add(n));
    } else if (ts.isParameter(node)) {
      collectBindingNames(node.name).forEach((n) => out.add(n));
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      out.add(node.name.text);
    } else if (ts.isImportClause(node) && node.name) {
      out.add(node.name.text);
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      out.add(node.name.text);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name).forEach((n) => out.add(n));
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** Names visible at `node` (superset: all names declared in enclosing functions plus module scope). */
export function getVisibleNames(node: ts.Node, sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  let current: ts.Node | undefined = node;
  while (current) {
    if (isFunctionLikeNode(current) || ts.isBlock(current) || ts.isSourceFile(current)) {
      collectDeclaredNames(current, names);
    }
    current = current.parent;
  }
  collectDeclaredNames(sf, names);
  return names;
}

export function containsKind(
  root: ts.Node,
  predicate: (n: ts.Node) => boolean,
  stopAtFunctions = true,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (predicate(node)) {
      found = true;
      return;
    }
    if (stopAtFunctions && node !== root && isFunctionLikeNode(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

export function containsAwait(root: ts.Node): boolean {
  return containsKind(root, (n) => ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && !!n.awaitModifier));
}

export function containsJsx(root: ts.Node): boolean {
  return containsKind(
    root,
    (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n),
    false,
  );
}

export function containsReturn(root: ts.Node): boolean {
  return containsKind(root, (n) => ts.isReturnStatement(n));
}

export function isHookCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
  return /^use[A-Z0-9]/.test(name);
}

export function hookNameOf(call: ts.CallExpression): string {
  const callee = call.expression;
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
}

export function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

/** Nearest JSX element/self-closing element enclosing the node. */
export function getEnclosingJsxElement(
  node: ts.Node,
): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined {
  return findAncestor(
    node,
    (n): n is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment =>
      ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n),
  );
}

export function getJsxTagName(
  el: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  sf: ts.SourceFile,
): string {
  if (ts.isJsxFragment(el)) {
    return '';
  }
  const tag = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  return tag.getText(sf);
}

/** Calls of undeclared identifiers inside `root`, e.g. `getUser(id)` when `getUser` is not declared. */
export interface UndeclaredCall {
  name: string;
  call: ts.CallExpression;
  isAwaited: boolean;
  argumentNodes: ts.Expression[];
}

const GLOBAL_NAMES = new Set([
  'console',
  'fetch',
  'require',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'parseInt',
  'parseFloat',
  'isNaN',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'Promise',
  'Error',
  'Date',
  'Math',
  'JSON',
  'Map',
  'Set',
  'Symbol',
  'RegExp',
  'structuredClone',
  'queueMicrotask',
  'describe',
  'it',
  'test',
  'expect',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'jest',
  'vi',
  'alert',
  'encodeURIComponent',
  'decodeURIComponent',
  'BigInt',
  'Buffer',
  'process',
  'globalThis',
  'window',
  'document',
]);

export function findUndeclaredCalls(root: ts.Node, visibleNames: Set<string>): UndeclaredCall[] {
  const result: UndeclaredCall[] = [];
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (!visibleNames.has(name) && !GLOBAL_NAMES.has(name) && !seen.has(name) && !/^use[A-Z]/.test(name)) {
        seen.add(name);
        result.push({
          name,
          call: node,
          isAwaited: !!node.parent && ts.isAwaitExpression(node.parent),
          argumentNodes: [...node.arguments],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}
