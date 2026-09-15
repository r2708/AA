import * as ts from 'typescript';
import type { LanguageAdapter } from '../languageAdapter';
import type {
  CodeContext,
  DocumentSnapshot,
  LanguageInfo,
  LineInfo,
  SelectionInfo,
  StyleInfo,
  TestFramework,
} from '../../types/context';
import {
  collectDeclarations,
  findExactNode,
  findNodeAtOffset,
  getEnclosingClass,
  getEnclosingFunction,
  getEnclosingStatement,
  getStatementsInRange,
  getSyntacticDiagnostics,
  getTopLevelStatement,
  isFunctionLikeNode,
  parseSource,
  type FunctionLikeNode,
} from '../../analyzer/astAnalyzer';
import { analyzeScope } from '../../analyzer/scopeAnalyzer';
import { analyzeReact } from '../../analyzer/reactAnalyzer';
import { createSingleFileChecker } from '../../analyzer/typeInference';
import { emptyProjectInfo } from '../../analyzer/projectDetector';
import { SUPPORTED_LANGUAGE_IDS } from '../../analyzer/languageDetector';
import { lineEndOf, lineStartOf, type TsAstContext } from './tsContext';

const TEST_MODULES: Record<string, TestFramework> = {
  vitest: 'vitest',
  '@playwright/test': 'playwright',
  mocha: 'mocha',
  chai: 'mocha',
  'node:test': 'node',
  'node:assert': 'node',
  'node:assert/strict': 'node',
  assert: 'node',
  '@jest/globals': 'jest',
};

function detectStyle(sf: ts.SourceFile): StyleInfo {
  let single = 0;
  let double = 0;
  let withSemi = 0;
  let withoutSemi = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node)) {
      const first = sf.text[node.getStart(sf)];
      if (first === "'") {
        single += 1;
      } else if (first === '"') {
        double += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const stmt of sf.statements.slice(0, 40)) {
    if (
      ts.isVariableStatement(stmt) ||
      ts.isExpressionStatement(stmt) ||
      ts.isImportDeclaration(stmt) ||
      ts.isReturnStatement(stmt)
    ) {
      if (sf.text[stmt.getEnd() - 1] === ';') {
        withSemi += 1;
      } else {
        withoutSemi += 1;
      }
    }
  }
  return {
    quote: double > single ? '"' : "'",
    semicolons: withoutSemi > withSemi ? false : true,
  };
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) {
    s += 1;
  }
  while (e > s && /\s/.test(text[e - 1])) {
    e -= 1;
  }
  return { start: s, end: e };
}

function isDeclarationStatement(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isImportDeclaration(node)
  );
}

function computeLine(text: string, cursor: number): LineInfo {
  const start = lineStartOf(text, cursor);
  const end = lineEndOf(text, cursor);
  const lineText = text.slice(start, end);
  const indent = /^[ \t]*/.exec(lineText)?.[0] ?? '';
  const index = text.slice(0, start).split('\n').length - 1;
  return { index, text: lineText, indent, isBlank: lineText.trim().length === 0, start, end };
}

function detectTestFramework(
  decls: CodeContext['declarations'],
  project: CodeContext['project'],
): TestFramework {
  for (const imp of decls.imports) {
    const fw = TEST_MODULES[imp.moduleSpecifier];
    if (fw) {
      return fw;
    }
  }
  if (project.testFramework) {
    return project.testFramework;
  }
  return 'jest';
}

function isTestFile(fileName: string, sf: ts.SourceFile): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(fileName) || /(^|[\\/])__tests__[\\/]/.test(fileName)) {
    return true;
  }
  return sf.statements.some(
    (s) =>
      ts.isExpressionStatement(s) &&
      ts.isCallExpression(s.expression) &&
      ts.isIdentifier(s.expression.expression) &&
      ['describe', 'it', 'test', 'suite'].includes(s.expression.expression.text),
  );
}

export class TypeScriptAdapter implements LanguageAdapter {
  readonly id = 'typescript';
  readonly displayName = 'JavaScript / TypeScript';
  readonly languageIds = SUPPORTED_LANGUAGE_IDS;

  private readonly cache = new Map<string, { version: number; text: string; sf: ts.SourceFile }>();

  private parse(snapshot: DocumentSnapshot, language: LanguageInfo): ts.SourceFile {
    const cached = this.cache.get(snapshot.uri);
    if (cached && cached.version === snapshot.version && cached.text === snapshot.text) {
      return cached.sf;
    }
    const sf = parseSource(snapshot.text, snapshot.fileName, language);
    if (this.cache.size > 16) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(snapshot.uri, { version: snapshot.version, text: snapshot.text, sf });
    return sf;
  }

  analyze(snapshot: DocumentSnapshot, language: LanguageInfo): CodeContext {
    const sf = this.parse(snapshot, language);
    const text = snapshot.text;
    const cursor = Math.max(0, Math.min(snapshot.cursor, text.length));
    const nodeAtCursor = findNodeAtOffset(sf, cursor);
    const decls = collectDeclarations(sf);

    // Selection analysis
    const rawSel = snapshot.selection;
    const trimmed =
      rawSel.end > rawSel.start ? trimRange(text, rawSel.start, rawSel.end) : { start: cursor, end: cursor };
    let selectedNode: ts.Node | undefined;
    let selectedStatements: ts.Statement[] = [];
    let selection: SelectionInfo;
    if (trimmed.end > trimmed.start) {
      selectedStatements = getStatementsInRange(sf, trimmed.start, trimmed.end);
      selectedNode = findExactNode(sf, trimmed.start, trimmed.end);
      let kind: SelectionInfo['kind'];
      if (selectedStatements.length > 0) {
        kind =
          selectedStatements.length === 1 && isDeclarationStatement(selectedStatements[0])
            ? 'declaration'
            : 'statements';
      } else if (selectedNode && ts.isIdentifier(selectedNode)) {
        kind = 'identifier';
      } else if (selectedNode && (ts.isExpression(selectedNode) || ts.isJsxAttribute(selectedNode))) {
        kind = 'expression';
      } else if (selectedNode && isDeclarationStatement(selectedNode)) {
        kind = 'declaration';
      } else {
        kind = 'partial';
      }
      const selText = text.slice(trimmed.start, trimmed.end);
      selection = {
        kind,
        range: trimmed,
        text: selText,
        statementCount: selectedStatements.length,
        isMultiLine: selText.includes('\n'),
      };
    } else {
      selection = {
        kind: 'none',
        range: { start: cursor, end: cursor },
        text: '',
        statementCount: 0,
        isMultiLine: false,
      };
    }

    const scope = analyzeScope(sf, nodeAtCursor, snapshot.indent);
    const project = snapshot.project ?? emptyProjectInfo();
    const react = analyzeReact(sf, decls, language, nodeAtCursor, snapshot.fileName);

    let enclosingComponentNode: FunctionLikeNode | undefined;
    if (react.enclosingComponent) {
      let current: ts.Node | undefined = nodeAtCursor;
      while (current) {
        if (isFunctionLikeNode(current) && current.getStart(sf) === react.enclosingComponent.range.start) {
          enclosingComponentNode = current;
          break;
        }
        current = current.parent;
      }
    }

    let checker: ts.TypeChecker | undefined;
    const ast: TsAstContext = {
      sourceFile: sf,
      nodeAtCursor,
      selectedNode,
      selectedStatements,
      enclosingFunctionNode: getEnclosingFunction(nodeAtCursor),
      enclosingClassNode: getEnclosingClass(nodeAtCursor),
      enclosingStatementNode: getEnclosingStatement(nodeAtCursor),
      topLevelStatementNode: getTopLevelStatement(nodeAtCursor),
      enclosingComponentNode,
      getChecker: () => {
        if (!checker) {
          checker = createSingleFileChecker(sf);
        }
        return checker;
      },
    };

    return {
      snapshot,
      language,
      text,
      eol: snapshot.eol,
      indent: snapshot.indent,
      style: detectStyle(sf),
      cursor,
      selection,
      currentLine: computeLine(text, cursor),
      declarations: decls,
      scope,
      react,
      project,
      testFramework: detectTestFramework(decls, project),
      diagnostics: getSyntacticDiagnostics(sf),
      isTestFile: isTestFile(snapshot.fileName, sf),
      ast,
    };
  }
}
