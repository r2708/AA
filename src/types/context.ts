/**
 * Core context types shared by every layer of CodePilot.
 *
 * Nothing in this file depends on the VS Code API: the analyzer, generators,
 * transformations and commands are all pure so they can be unit-tested in Node.
 */

/** Half-open character offset range inside a document. */
export interface Range {
  start: number;
  end: number;
}

export interface IndentInfo {
  useTabs: boolean;
  size: number;
  /** The literal string used for one indentation level ("\t" or spaces). */
  unit: string;
}

export interface LanguageInfo {
  id: string;
  family: 'javascript' | 'unknown';
  isTypeScript: boolean;
  isJsx: boolean;
  supported: boolean;
}

export type BackendFramework = 'express' | 'fastify' | 'koa' | 'hono' | 'next' | 'nest' | 'hapi';
export type TestFramework = 'jest' | 'vitest' | 'mocha' | 'playwright' | 'node';

export interface ProjectInfo {
  packageJsonDir?: string;
  dependencies: string[];
  backendFramework?: BackendFramework;
  testFramework?: TestFramework;
  hasReact: boolean;
  isEsm: boolean;
}

/** Everything the host editor knows about the document at invocation time. */
export interface DocumentSnapshot {
  uri: string;
  fileName: string;
  languageId: string;
  text: string;
  version: number;
  /** Normalised selection (start <= end). Empty when start === end. */
  selection: Range;
  /** Active cursor offset. */
  cursor: number;
  eol: '\n' | '\r\n';
  indent: IndentInfo;
  workspaceRoot?: string;
  project?: ProjectInfo;
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'method'
  | 'property'
  | 'component'
  | 'hook';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  range: Range;
  isExported: boolean;
  isDefaultExport?: boolean;
}

export interface ParameterInfo {
  name: string;
  typeText?: string;
  optional: boolean;
  hasDefault: boolean;
  isRest: boolean;
  /** Original parameter source text (including destructuring patterns). */
  text: string;
}

export interface FunctionInfo extends SymbolInfo {
  parameters: ParameterInfo[];
  returnTypeText?: string;
  isAsync: boolean;
  isGenerator: boolean;
  isArrow: boolean;
  bodyRange?: Range;
  /** True when the body is an expression (arrow function without braces). */
  hasExpressionBody: boolean;
}

export interface PropertyInfo {
  name: string;
  typeText?: string;
  optional: boolean;
  hasInitializer: boolean;
  initializerText?: string;
  range: Range;
  isStatic: boolean;
  readonly: boolean;
  visibility?: 'public' | 'private' | 'protected';
}

export interface MethodInfo extends FunctionInfo {
  isStatic: boolean;
  visibility?: 'public' | 'private' | 'protected';
}

export interface ClassInfo extends SymbolInfo {
  properties: PropertyInfo[];
  methods: MethodInfo[];
  hasConstructor: boolean;
  constructorRange?: Range;
  extendsName?: string;
  implementsNames: string[];
  /** Range between the braces of the class body. */
  bodyRange: Range;
  isAbstract: boolean;
}

export interface InterfaceInfo extends SymbolInfo {
  members: PropertyInfo[];
  methods: MethodInfo[];
  extendsNames: string[];
  bodyRange: Range;
}

export interface TypeAliasInfo extends SymbolInfo {
  typeText: string;
  /** Present when the alias is an object type literal. */
  members?: PropertyInfo[];
  /** Present when the alias is a union of string/number literals. */
  unionLiterals?: string[];
}

export interface EnumMemberInfo {
  name: string;
  valueText?: string;
}

export interface EnumInfo extends SymbolInfo {
  members: EnumMemberInfo[];
  isConst: boolean;
}

export interface VariableInfo extends SymbolInfo {
  declarationKind: 'const' | 'let' | 'var';
  typeText?: string;
  initializerText?: string;
  /** Best-effort classification of the initializer. */
  initializerKind?: 'array' | 'object' | 'function' | 'call' | 'literal' | 'other';
  isTopLevel: boolean;
}

export interface NamedImport {
  name: string;
  alias?: string;
  isType: boolean;
}

export interface ImportInfo {
  moduleSpecifier: string;
  defaultImport?: string;
  namespaceImport?: string;
  namedImports: NamedImport[];
  isTypeOnly: boolean;
  isSideEffectOnly: boolean;
  range: Range;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  range: Range;
}

export interface Declarations {
  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  interfaces: InterfaceInfo[];
  types: TypeAliasInfo[];
  enums: EnumInfo[];
  variables: VariableInfo[];
  /** Every top-level binding name (values and types), including import bindings. */
  topLevelNames: Set<string>;
}

export type ScopeKind =
  'module' | 'function' | 'method' | 'class' | 'block' | 'object' | 'interface' | 'jsx' | 'unknown';

export interface ScopeInfo {
  kind: ScopeKind;
  isAsync: boolean;
  isGenerator: boolean;
  enclosingFunction?: FunctionInfo;
  enclosingClass?: ClassInfo;
  enclosingMethod?: MethodInfo;
  enclosingInterface?: InterfaceInfo;
  /** The innermost statement containing the cursor. */
  enclosingStatement?: Range;
  /** The top-level statement containing the cursor. */
  topLevelStatement?: Range;
  /** True when the cursor is directly inside a class body (not inside a method). */
  inClassBody: boolean;
  inObjectLiteral: boolean;
  inInterfaceBody: boolean;
  inJsx: boolean;
  inCatchClause: boolean;
  catchVariableName?: string;
  /** Names visible at the cursor (conservative superset used for collision avoidance). */
  visibleNames: Set<string>;
  /** Indentation string expected for a new statement at the cursor. */
  statementIndent: string;
}

export type SelectionKind = 'none' | 'identifier' | 'expression' | 'statements' | 'declaration' | 'partial';

export interface SelectionInfo {
  kind: SelectionKind;
  /** Selection range trimmed of surrounding whitespace. */
  range: Range;
  text: string;
  /** Number of statements when kind === 'statements'. */
  statementCount: number;
  isMultiLine: boolean;
}

export interface ComponentInfo extends FunctionInfo {
  propsParamName?: string;
  propsTypeText?: string;
  destructuredProps: string[];
  propsAccessed: string[];
  hooksUsed: string[];
  /** Offset right after the last hook call statement in the body (or body start). */
  hookInsertOffset?: number;
}

export interface ReactInfo {
  isReact: boolean;
  hasReactImport: boolean;
  reactImport?: ImportInfo;
  components: ComponentInfo[];
  enclosingComponent?: ComponentInfo;
  hooksUsed: string[];
  inJsx: boolean;
  /** Tag name of the innermost JSX element at the cursor / selection, if any. */
  jsxTagName?: string;
}

export interface StyleInfo {
  quote: '"' | "'";
  semicolons: boolean;
}

export interface DiagnosticInfo {
  message: string;
  range: Range;
}

export interface LineInfo {
  index: number;
  text: string;
  indent: string;
  isBlank: boolean;
  start: number;
  end: number;
}

/**
 * Fully analysed context passed to every command.
 * `ast` is language-adapter specific (the TypeScript adapter stores a TsAstContext there).
 */
export interface CodeContext {
  snapshot: DocumentSnapshot;
  language: LanguageInfo;
  text: string;
  eol: '\n' | '\r\n';
  indent: IndentInfo;
  style: StyleInfo;
  cursor: number;
  selection: SelectionInfo;
  currentLine: LineInfo;
  declarations: Declarations;
  scope: ScopeInfo;
  react: ReactInfo;
  project: ProjectInfo;
  testFramework: TestFramework;
  diagnostics: DiagnosticInfo[];
  /** True when the file is a test file (name or content). */
  isTestFile: boolean;
  /** Language adapter specific AST payload. */
  ast?: unknown;
}
