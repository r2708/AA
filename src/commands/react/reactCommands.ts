/**
 * React commands (Ctrl+Alt+Shift+F1 ... Ctrl+Alt+Shift+F12).
 * Only available in files that use React (JSX/TSX, React import, hooks).
 */
import * as ts from 'typescript';
import type { CodeContext, ComponentInfo } from '../../types/context';
import {
  CodePilotError,
  type Applicability,
  type CommandDefinition,
  type CommandResult,
  type TextEdit,
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
} from '../helpers';
import {
  getSelectedExpression,
  lineIndentAt,
  tsOf,
  unwrapExpression,
} from '../../languages/typescript/tsContext';
import {
  collectDeclaredNames,
  collectValueReferences,
  getEnclosingJsxElement,
  getJsxTagName,
  isHookCall,
  isPascalCase,
} from '../../analyzer/astAnalyzer';
import { inferTypeFromUsage, checkerTypeText } from '../../analyzer/typeInference';
import { capitalize, nameFromFileName, toPascalCase, uniqueName } from '../../analyzer/naming';
import { ensureImports, type ImportRequest } from '../../transformations/importManager';
import {
  planStatementInsertion,
  planTopLevelInsertion,
  type InsertionPlan,
} from '../../transformations/insertion';
import { extractFunction } from '../../transformations/extractFunction';
import {
  dedentSubsequentLines,
  escapeSnippet,
  indentAllLines,
  renderCode,
  semi,
} from '../../generators/codeWriter';
import { prefersArrowFunctions } from '../../generators/functionGenerator';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function requireReact(ctx: CodeContext): Applicability | undefined {
  if (!ctx.react.isReact && !ctx.language.isJsx && !ctx.project.hasReact) {
    return no('This command is for React files (JSX/TSX or files importing React).');
  }
  return undefined;
}

function requireComponentBody(ctx: CodeContext): Applicability | undefined {
  const fn = ctx.scope.enclosingFunction;
  if (!fn) {
    return no('Place the cursor inside a React component or custom hook.');
  }
  const isHookFn = /^use[A-Z]/.test(fn.name);
  if (!ctx.react.enclosingComponent && !isHookFn) {
    return no(
      `Hooks can only be called from a component or a custom hook (the cursor is inside ${fn.name || 'a plain function'}).`,
    );
  }
  return undefined;
}

/** Statement insertion inside the component: at the cursor when it is in the body, else after the last hook call. */
function hookPlan(ctx: CodeContext): InsertionPlan {
  const comp = ctx.react.enclosingComponent;
  const inBody = comp?.bodyRange && ctx.cursor > comp.bodyRange.start && ctx.cursor <= comp.bodyRange.end;
  if (inBody && canInsertStatement(ctx)) {
    return planStatementInsertion(ctx);
  }
  if (comp?.hookInsertOffset !== undefined && comp.bodyRange) {
    const offset = comp.hookInsertOffset;
    const indent = lineIndentAt(ctx.text, comp.range.start) + ctx.indent.unit;
    return { range: { start: offset, end: offset }, indent, prefix: ctx.eol + indent, suffix: '' };
  }
  return planStatementInsertion(ctx);
}

function withReactImports(
  ctx: CodeContext,
  result: CommandResult,
  names: string[],
  typeNames: string[] = [],
): CommandResult {
  const requests: ImportRequest[] = [];
  if (names.length) {
    requests.push({ module: 'react', named: names });
  }
  if (typeNames.length && ctx.language.isTypeScript) {
    requests.push({ module: 'react', named: typeNames, typeOnly: true });
  }
  const resolution = ensureImports(ctx, requests);
  const edits: TextEdit[] = [...(result.edits ?? []), ...resolution.edits];
  const message = resolution.added.length
    ? `${result.message ?? ''}${result.message ? ' · ' : ''}Added ${resolution.added.join(', ')} to the react import`.trim()
    : result.message;
  return { ...result, edits, message };
}

/** Names declared in the enclosing component (props, state, locals) referenced by `node`. */
function componentScopeDependencies(ctx: CodeContext, node: ts.Node): string[] {
  const ast = tsOf(ctx);
  const comp = ast.enclosingComponentNode ?? ast.enclosingFunctionNode;
  if (!comp) {
    return [];
  }
  const declared = new Set<string>();
  comp.parameters.forEach((p) => collectDeclaredNames(p, declared));
  if (comp.body) {
    collectDeclaredNames(comp.body, declared);
  }
  const inside = collectDeclaredNames(node);
  const refs = collectValueReferences(node);
  const deps: string[] = [];
  for (const name of refs.keys()) {
    if (declared.has(name) && !inside.has(name)) {
      deps.push(name);
    }
  }
  return deps;
}

const TAG_ELEMENT_TYPES: Record<string, string> = {
  div: 'HTMLDivElement',
  span: 'HTMLSpanElement',
  input: 'HTMLInputElement',
  button: 'HTMLButtonElement',
  form: 'HTMLFormElement',
  a: 'HTMLAnchorElement',
  img: 'HTMLImageElement',
  textarea: 'HTMLTextAreaElement',
  select: 'HTMLSelectElement',
  ul: 'HTMLUListElement',
  ol: 'HTMLOListElement',
  li: 'HTMLLIElement',
  canvas: 'HTMLCanvasElement',
  video: 'HTMLVideoElement',
  audio: 'HTMLAudioElement',
  p: 'HTMLParagraphElement',
  h1: 'HTMLHeadingElement',
  h2: 'HTMLHeadingElement',
  h3: 'HTMLHeadingElement',
  h4: 'HTMLHeadingElement',
  h5: 'HTMLHeadingElement',
  h6: 'HTMLHeadingElement',
  table: 'HTMLTableElement',
  label: 'HTMLLabelElement',
  svg: 'SVGSVGElement',
  section: 'HTMLElement',
  article: 'HTMLElement',
  nav: 'HTMLElement',
  header: 'HTMLElement',
  footer: 'HTMLElement',
  main: 'HTMLElement',
  dialog: 'HTMLDialogElement',
  iframe: 'HTMLIFrameElement',
};

function eventTypeFor(attr: string, tag: string | undefined): string {
  const el = tag && TAG_ELEMENT_TYPES[tag] ? TAG_ELEMENT_TYPES[tag] : 'HTMLElement';
  if (/^on(Click|DoubleClick|Mouse\w*|ContextMenu)$/.test(attr)) {
    return `React.MouseEvent<${el}>`;
  }
  if (/^on(Change|Input)$/.test(attr)) {
    return `React.ChangeEvent<${tag === 'select' ? 'HTMLSelectElement' : tag === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement'}>`;
  }
  if (attr === 'onSubmit') {
    return 'React.FormEvent<HTMLFormElement>';
  }
  if (/^onKey/.test(attr)) {
    return `React.KeyboardEvent<${el}>`;
  }
  if (/^on(Focus|Blur)$/.test(attr)) {
    return `React.FocusEvent<${el}>`;
  }
  if (/^on(Drag|Drop)/.test(attr)) {
    return `React.DragEvent<${el}>`;
  }
  if (/^onTouch/.test(attr)) {
    return `React.TouchEvent<${el}>`;
  }
  if (/^onPointer/.test(attr)) {
    return `React.PointerEvent<${el}>`;
  }
  return 'React.SyntheticEvent';
}

function reactNamespaceImport(ctx: CodeContext): ImportRequest[] {
  if (!ctx.language.isTypeScript) {
    return [];
  }
  const existing = ctx.react.reactImport;
  if (existing && (existing.defaultImport === 'React' || existing.namespaceImport === 'React')) {
    return [];
  }
  return [{ module: 'react', defaultName: 'React', typeOnly: !existing }];
}

function selectedJsx(
  ctx: CodeContext,
): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined {
  const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
  const node = expr ? unwrapExpression(expr) : tsOf(ctx).selectedNode;
  if (node && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))) {
    return node;
  }
  return undefined;
}

function componentNameFromJsx(
  ctx: CodeContext,
  jsx: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
): string {
  const sf = tsOf(ctx).sourceFile;
  const opening = ts.isJsxElement(jsx)
    ? jsx.openingElement
    : ts.isJsxSelfClosingElement(jsx)
      ? jsx
      : undefined;
  if (opening) {
    for (const attr of opening.attributes.properties) {
      if (
        ts.isJsxAttribute(attr) &&
        ts.isIdentifier(attr.name) &&
        (attr.name.text === 'className' || attr.name.text === 'id' || attr.name.text === 'data-testid') &&
        attr.initializer &&
        ts.isStringLiteral(attr.initializer)
      ) {
        const first = attr.initializer.text.split(/\s+/)[0];
        if (first) {
          return toPascalCase(first);
        }
      }
    }
    const tag = getJsxTagName(jsx, sf);
    if (tag && /^[A-Z]/.test(tag)) {
      return `${tag}Wrapper`;
    }
  }
  return 'ExtractedComponent';
}

function extractComponent(
  ctx: CodeContext,
  jsx: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
): CommandResult {
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  const sc = semi(ctx);
  const isTs = ctx.language.isTypeScript;
  const name = uniqueName(componentNameFromJsx(ctx, jsx), ctx.declarations.topLevelNames);
  const props = componentScopeDependencies(ctx, jsx);
  const start = jsx.getStart(sf);
  const end = jsx.getEnd();
  const original = ctx.text.slice(start, end);
  const body = indentAllLines(
    dedentSubsequentLines(original, lineIndentAt(ctx.text, start), '\n'),
    '\t\t',
    '\n',
  ).replace(/^\t\t/, '\t\t');
  const propTypes = props.map((p) => {
    const refs = collectValueReferences(jsx).get(p) ?? [];
    const inferred =
      (refs[0] && checkerTypeText(ast.getChecker(), refs[0])) ??
      inferTypeFromUsage(p, jsx) ??
      (/^on[A-Z]/.test(p) ? '() => void' : 'unknown');
    return `\t${p}: ${inferred}${sc}`;
  });
  const lines: string[] = [];
  if (isTs && props.length) {
    lines.push(`interface ${name}Props {\n${propTypes.join('\n')}\n}`, '');
  }
  const params = props.length ? `{ ${props.join(', ')} }${isTs ? `: ${name}Props` : ''}` : '';
  lines.push(`function ${name}(${params}) {\n\treturn (\n${body}\n\t)${sc}\n}`);
  const declaration = lines.join('\n');
  const plan = planTopLevelInsertion(ctx, { position: 'after' });
  const usage = `<${name}${props.map((p) => ` ${p}={${p}}`).join('')} />`;
  return {
    edits: [
      { range: { start, end }, text: usage },
      {
        range: plan.range,
        text: plan.prefix + renderCode(declaration, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
      },
    ],
    message: `Extracted JSX into <${name}> with ${props.length} prop${props.length === 1 ? '' : 's'}`,
  };
}

// ---------------------------------------------------------------------------
// F1 React Component
// ---------------------------------------------------------------------------

export const createReactComponent: CommandDefinition = defineCommand({
  id: 'codepilot.createReactComponent',
  title: 'Create React Component',
  category: 'react',
  description:
    'Extracts the selected JSX into a new component (props inferred from used variables) or creates a component named after the file.',
  keybinding: { key: 'ctrl+alt+shift+f1' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx);
    if (gate) {
      return gate;
    }
    if (selectedJsx(ctx)) {
      return ok(85, 'Extract the selected JSX into a new component');
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select a JSX element to extract, or clear the selection.');
    }
    if (
      ctx.scope.kind === 'jsx' ||
      ctx.scope.kind === 'object' ||
      ctx.scope.kind === 'interface' ||
      ctx.scope.kind === 'class'
    ) {
      return no('Move the cursor to a statement position to create a component.');
    }
    const name = nameFromFileName(ctx.snapshot.fileName);
    const exists = ctx.declarations.topLevelNames.has(name);
    return ok(exists ? 25 : 45, `Create component ${exists ? 'NewComponent' : name}`);
  },
  async execute(ctx) {
    const jsx = selectedJsx(ctx);
    if (jsx) {
      return extractComponent(ctx, jsx);
    }
    const sc = semi(ctx);
    const isTs = ctx.language.isTypeScript;
    const fileName = nameFromFileName(ctx.snapshot.fileName);
    const base =
      ctx.declarations.topLevelNames.has(fileName) || !isPascalCase(fileName) ? 'NewComponent' : fileName;
    const name = uniqueName(base, ctx.declarations.topLevelNames);
    const hasDefault = ctx.declarations.exports.some((e) => e.isDefault);
    const exportPrefix = ctx.react.components.length === 0 && !hasDefault ? 'export default ' : 'export ';
    const propsInterface = isTs ? `interface \${1:${name}}Props {\n\t\${2}\n}\n\n` : '';
    const params = isTs ? `\${3:props}: \${1}Props` : `\${3:props}`;
    const arrow = prefersArrowFunctions(ctx) && exportPrefix !== 'export default ';
    const fn = arrow
      ? `${exportPrefix}const \${1:${name}} = (${params}) => {\n\treturn (\n\t\t<\${4:div}>\n\t\t\t$0\n\t\t</\${4}>\n\t)${sc}\n}${sc}`
      : `${exportPrefix}function \${1:${name}}(${params}) {\n\treturn (\n\t\t<\${4:div}>\n\t\t\t$0\n\t\t</\${4}>\n\t)${sc}\n}`;
    const template = propsInterface + fn;
    const position = ctx.scope.kind === 'module' ? 'after' : 'after';
    return insertTopLevelSnippet(ctx, template, { position });
  },
});

// ---------------------------------------------------------------------------
// F3 useState
// ---------------------------------------------------------------------------

export const createUseState: CommandDefinition = defineCommand({
  id: 'codepilot.createUseState',
  title: 'Create useState',
  category: 'react',
  description:
    'Adds a useState hook (typed from the selected initial value) at the right position and imports useState if needed.',
  keybinding: { key: 'ctrl+alt+shift+f3' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    return (
      requireReact(ctx) ??
      requireComponentBody(ctx) ??
      ok(
        ctx.selection.kind === 'none' ? 40 : 55,
        ctx.selection.kind === 'none'
          ? 'Add a useState hook'
          : `Create state initialised with ${describeSelection(ctx)}`,
      )
    );
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const ast = tsOf(ctx);
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    const q = ctx.style.quote;
    let name = 'value';
    let initial = `\${3:${q}${q}}`;
    let typeText: string | undefined;
    if (expr) {
      const e = unwrapExpression(expr);
      initial = e.getText(ast.sourceFile);
      typeText = checkerTypeText(ast.getChecker(), e);
      if (ts.isIdentifier(e)) {
        name = e.text;
        initial = '${3:undefined}';
      } else if (ts.isStringLiteral(e)) {
        name = 'text';
      } else if (ts.isNumericLiteral(e)) {
        name = 'count';
      } else if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) {
        name = 'isOpen';
      } else if (ts.isArrayLiteralExpression(e)) {
        name = 'items';
        typeText = typeText ?? 'unknown[]';
      } else if (ts.isObjectLiteralExpression(e)) {
        name = 'form';
      }
    }
    name = uniqueName(name, ctx.scope.visibleNames);
    const generic = ctx.language.isTypeScript
      ? `<\${2:${escapeSnippet(typeText ?? (initial === 'null' ? 'string | null' : 'string'))}}>`
      : '';
    const initialText = initial.startsWith('${3:') ? initial : escapeSnippet(initial);
    const template = `const [\${1:${name}}, set\${1/(.*)/\${1:/capitalize}/}] = useState${generic}(${initialText})${sc}`;
    const target = expr && expr.parent && ts.isExpressionStatement(expr.parent) ? expr.parent : undefined;
    let result: CommandResult;
    if (target) {
      const start = target.getStart(ast.sourceFile);
      result = {
        snippet: {
          range: { start, end: target.getEnd() },
          body: renderCode(template, ctx, lineIndentAt(ctx.text, start)),
        },
      };
    } else {
      result = snippetAtPlan(ctx, hookPlan(ctx), template);
    }
    return withReactImports(ctx, result, ['useState']);
  },
});

// ---------------------------------------------------------------------------
// F4 useEffect
// ---------------------------------------------------------------------------

export const createUseEffect: CommandDefinition = defineCommand({
  id: 'codepilot.createUseEffect',
  title: 'Create useEffect',
  category: 'react',
  description:
    'Wraps the selected statements in useEffect with an inferred dependency array, or adds an empty effect.',
  keybinding: { key: 'ctrl+alt+shift+f4' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx) ?? requireComponentBody(ctx);
    if (gate) {
      return gate;
    }
    if (ctx.selection.kind === 'statements') {
      return ok(70, `Move ${describeSelection(ctx)} into a useEffect with inferred dependencies`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select complete statements or clear the selection.');
    }
    return ok(35, 'Add a useEffect hook');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const ast = tsOf(ctx);
    if (ctx.selection.kind === 'statements') {
      const stmts = ast.selectedStatements;
      const deps = new Set<string>();
      stmts.forEach((s) => componentScopeDependencies(ctx, s).forEach((d) => deps.add(d)));
      const first = stmts[0];
      const last = stmts[stmts.length - 1];
      const start = first.getStart(ast.sourceFile);
      const baseIndent = lineIndentAt(ctx.text, start);
      const original = ctx.text.slice(start, last.getEnd());
      const hasAwait = /\bawait\b/.test(original);
      const inner = indentAllLines(
        dedentSubsequentLines(original, baseIndent, '\n'),
        hasAwait ? '\t\t' : '\t',
        '\n',
      );
      const depsText = [...deps].join(', ');
      const code = hasAwait
        ? `useEffect(() => {\n\tconst run = async () => {\n${inner}\n\t}${sc}\n\trun()${sc}\n}, [${depsText}])${sc}`
        : `useEffect(() => {\n${inner}\n}, [${depsText}])${sc}`;
      const result: CommandResult = {
        edits: [{ range: { start, end: last.getEnd() }, text: renderCode(code, ctx, baseIndent) }],
        message: `Wrapped in useEffect with deps [${depsText}]`,
      };
      return withReactImports(ctx, result, ['useEffect']);
    }
    const result = snippetAtPlan(ctx, hookPlan(ctx), `useEffect(() => {\n\t$0\n}, [\${1}])${sc}`);
    return withReactImports(ctx, result, ['useEffect']);
  },
});

// ---------------------------------------------------------------------------
// F5 useMemo / F6 useCallback
// ---------------------------------------------------------------------------

function memoize(ctx: CodeContext, hook: 'useMemo' | 'useCallback'): CommandResult {
  const sc = semi(ctx);
  const ast = tsOf(ctx);
  const sf = ast.sourceFile;
  let expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
  // Cursor inside `const handler = () => {}` → memoize the whole initializer.
  if (!expr && ctx.selection.kind === 'none') {
    const boundary = ast.enclosingComponentNode;
    let node: ts.Node | undefined = ast.nodeAtCursor;
    while (node && node !== boundary && !ts.isSourceFile(node)) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = unwrapExpression(node.initializer);
        if (hook === 'useMemo' || ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          expr = node.initializer;
          break;
        }
      }
      node = node.parent;
    }
  }
  if (!expr) {
    const skeleton =
      hook === 'useMemo'
        ? `const \${1:value} = useMemo(() => \${2:compute()}, [\${3}])${sc}`
        : `const \${1:handle} = useCallback((\${2}) => {\n\t$0\n}, [\${3}])${sc}`;
    return withReactImports(ctx, snippetAtPlan(ctx, hookPlan(ctx), skeleton), [hook]);
  }
  const e = unwrapExpression(expr);
  if (hook === 'useCallback' && !ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) {
    throw new CodePilotError(
      'invalidSelection',
      'useCallback needs a function expression. Select an arrow function or use useMemo for values.',
    );
  }
  if (
    /^use(Memo|Callback)\(/.test(e.getText(sf)) ||
    (e.parent && ts.isCallExpression(e.parent) && isHookCall(e.parent))
  ) {
    throw new CodePilotError('invalidTransformation', 'The expression is already memoized.');
  }
  const deps = componentScopeDependencies(ctx, e).join(', ');
  const exprText = e.getText(sf);
  const wrapped =
    hook === 'useMemo'
      ? `useMemo(() => ${ts.isObjectLiteralExpression(e) ? `(${exprText})` : exprText}, [${deps}])`
      : `useCallback(${exprText}, [${deps}])`;
  const parent = e.parent;
  const edits: TextEdit[] = [];
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === e) {
    edits.push({ range: { start: e.getStart(sf), end: e.getEnd() }, text: wrapped });
  } else if (
    parent &&
    ts.isParenthesizedExpression(parent) &&
    parent.parent &&
    ts.isVariableDeclaration(parent.parent)
  ) {
    edits.push({ range: { start: parent.getStart(sf), end: parent.getEnd() }, text: wrapped });
  } else {
    const stmt = ast.enclosingStatementNode ?? ast.selectedStatements[0];
    if (!stmt) {
      throw new CodePilotError(
        'invalidTransformation',
        'Could not find where to declare the memoized value.',
      );
    }
    const name = uniqueName(hook === 'useMemo' ? 'memoized' : 'handler', ctx.scope.visibleNames);
    const stmtStart = stmt.getStart(sf);
    const indent = lineIndentAt(ctx.text, stmtStart);
    edits.push({
      range: { start: stmtStart, end: stmtStart },
      text: `const ${name} = ${wrapped}${sc}${ctx.eol}${indent}`,
    });
    edits.push({ range: { start: e.getStart(sf), end: e.getEnd() }, text: name });
  }
  return withReactImports(ctx, { edits, message: `Wrapped in ${hook} with deps [${deps}]` }, [hook]);
}

export const createUseMemo: CommandDefinition = defineCommand({
  id: 'codepilot.createUseMemo',
  title: 'Create useMemo',
  category: 'react',
  description:
    'Memoizes the selected expression with useMemo, inferring the dependency array from component-scope variables.',
  keybinding: { key: 'ctrl+alt+shift+f5' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx) ?? requireComponentBody(ctx);
    if (gate) {
      return gate;
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      return ok(60, `Memoize ${describeSelection(ctx)} with useMemo`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select the expression to memoize.');
    }
    return ok(25, 'Add a useMemo hook');
  },
  execute: async (ctx) => memoize(ctx, 'useMemo'),
});

export const createUseCallback: CommandDefinition = defineCommand({
  id: 'codepilot.createUseCallback',
  title: 'Create useCallback',
  category: 'react',
  description:
    'Wraps the selected (or enclosing) arrow function in useCallback with an inferred dependency array.',
  keybinding: { key: 'ctrl+alt+shift+f6' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx) ?? requireComponentBody(ctx);
    if (gate) {
      return gate;
    }
    const expr = ctx.selection.kind === 'none' ? undefined : getSelectedExpression(ctx);
    if (expr) {
      const e = unwrapExpression(expr);
      return ts.isArrowFunction(e) || ts.isFunctionExpression(e)
        ? ok(65, 'Wrap the function in useCallback')
        : no('useCallback needs a function expression; use useMemo for values.');
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select an arrow function.');
    }
    return ok(25, 'Add a useCallback hook');
  },
  execute: async (ctx) => memoize(ctx, 'useCallback'),
});

// ---------------------------------------------------------------------------
// F7 useRef
// ---------------------------------------------------------------------------

export const createUseRef: CommandDefinition = defineCommand({
  id: 'codepilot.createUseRef',
  title: 'Create useRef',
  category: 'react',
  description:
    'Adds a useRef hook; when the cursor is on a JSX element it creates a typed element ref and attaches ref={...}.',
  keybinding: { key: 'ctrl+alt+shift+f7' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx) ?? requireComponentBody(ctx);
    if (gate) {
      return gate;
    }
    const tag = ctx.react.jsxTagName;
    if (tag && /^[a-z]/.test(tag)) {
      return ok(65, `Create a ref for <${tag}> and attach it`);
    }
    return ok(25, 'Add a useRef hook');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const ast = tsOf(ctx);
    const sf = ast.sourceFile;
    const el = getEnclosingJsxElement(ast.nodeAtCursor);
    const tag = el ? getJsxTagName(el, sf) : undefined;
    if (el && tag && /^[a-z]/.test(tag) && !ts.isJsxFragment(el)) {
      const opening = ts.isJsxElement(el) ? el.openingElement : el;
      const hasRef = opening.attributes.properties.some(
        (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'ref',
      );
      if (hasRef) {
        throw new CodePilotError('duplicate', `<${tag}> already has a ref attribute.`);
      }
      const name = uniqueName(`${tag}Ref`, ctx.scope.visibleNames);
      const elementType = TAG_ELEMENT_TYPES[tag] ?? 'HTMLElement';
      const generic = ctx.language.isTypeScript ? `<${elementType}>` : '';
      const declaration = `const ${name} = useRef${generic}(null)${sc}`;
      const plan = hookPlan(ctx);
      const attrPos = opening.tagName.getEnd();
      const edits: TextEdit[] = [
        {
          range: plan.range,
          text: plan.prefix + renderCode(declaration, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
        },
        { range: { start: attrPos, end: attrPos }, text: ` ref={${name}}` },
      ];
      return withReactImports(ctx, { edits, message: `Created ${name} and attached it to <${tag}>` }, [
        'useRef',
      ]);
    }
    const generic = ctx.language.isTypeScript ? `<\${2:HTMLDivElement}>` : '';
    return withReactImports(
      ctx,
      snippetAtPlan(ctx, hookPlan(ctx), `const \${1:ref} = useRef${generic}(\${3:null})${sc}`),
      ['useRef'],
    );
  },
});

// ---------------------------------------------------------------------------
// F8 React Context
// ---------------------------------------------------------------------------

export const createReactContext: CommandDefinition = defineCommand({
  id: 'codepilot.createReactContext',
  title: 'Create React Context',
  category: 'react',
  description:
    'Generates a context with a typed value, a Provider component and a `useX()` hook that guards against missing providers.',
  keybinding: { key: 'ctrl+alt+shift+f8' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx);
    if (gate) {
      return gate;
    }
    if (ctx.selection.kind !== 'none') {
      return no('Clear the selection to create a context.');
    }
    return ok(30, 'Create a context, provider and hook');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    const isTs = ctx.language.isTypeScript;
    const base = nameFromFileName(ctx.snapshot.fileName).replace(/(Context|Provider)$/, '') || 'App';
    const name = uniqueName(
      base,
      new Set([...ctx.declarations.topLevelNames].map((n) => n.replace(/Context$/, ''))),
    );
    const valueType = isTs ? `\${1:${name}}ContextValue` : '';
    const q = ctx.style.quote;
    const lines: string[] = [];
    if (isTs) {
      lines.push(`interface ${valueType} {\n\t\${2}\n}\n`);
    }
    lines.push(
      `const \${1:${name}}Context = createContext${isTs ? `<${valueType} | undefined>` : ''}(undefined)${sc}\n`,
    );
    const childrenParam = isTs ? `{ children }: { children: ReactNode }` : `{ children }`;
    if (ctx.language.isJsx) {
      lines.push(
        `export function \${1}Provider(${childrenParam}) {\n\tconst value${isTs ? `: ${valueType}` : ''} = {\n\t\t$0\n\t}${sc}\n\treturn <\${1}Context.Provider value={value}>{children}</\${1}Context.Provider>${sc}\n}\n`,
      );
    } else {
      lines.push(
        `export function \${1}Provider(${childrenParam}) {\n\tconst value${isTs ? `: ${valueType}` : ''} = {\n\t\t$0\n\t}${sc}\n\treturn createElement(\${1}Context.Provider, { value }, children)${sc}\n}\n`,
      );
    }
    lines.push(
      `export function use\${1}() {\n\tconst context = useContext(\${1}Context)${sc}\n\tif (!context) {\n\t\tthrow new Error(${q}use\${1} must be used within a \${1}Provider${q})${sc}\n\t}\n\treturn context${sc}\n}`,
    );
    const result = insertTopLevelSnippet(ctx, lines.join('\n'), { position: 'after' });
    const names = ['createContext', 'useContext', ...(ctx.language.isJsx ? [] : ['createElement'])];
    return withReactImports(ctx, result, names, ['ReactNode']);
  },
});

// ---------------------------------------------------------------------------
// F9 Custom Hook / F2 React Hook (chooser)
// ---------------------------------------------------------------------------

export const createCustomHook: CommandDefinition = defineCommand({
  id: 'codepilot.createCustomHook',
  title: 'Create Custom Hook',
  category: 'react',
  description:
    'Extracts the selected hook-using statements into a custom hook, or creates a `useX` hook skeleton.',
  keybinding: { key: 'ctrl+alt+shift+f9' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx);
    if (gate) {
      return gate;
    }
    if (ctx.selection.kind === 'statements') {
      const usesHook = tsOf(ctx).selectedStatements.some((s) => /\buse[A-Z]\w*\(/.test(s.getText()));
      return usesHook
        ? ok(80, `Extract ${describeSelection(ctx)} into a custom hook`)
        : ok(30, `Extract ${describeSelection(ctx)} into a hook (no hook calls detected)`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select complete statements to extract into a hook.');
    }
    if (ctx.scope.kind === 'jsx' || ctx.scope.kind === 'class' || ctx.scope.kind === 'object') {
      return no('Move the cursor to a statement position.');
    }
    return ok(30, 'Create a custom hook skeleton');
  },
  async execute(ctx) {
    const sc = semi(ctx);
    if (ctx.selection.kind === 'statements') {
      const first = tsOf(ctx).selectedStatements[0];
      const decl = ts.isVariableStatement(first)
        ? first.declarationList.declarations[0]?.name.getText()
        : undefined;
      const baseName = decl
        ? `use${capitalize(
            decl
              .replace(/^\[|\]$/g, '')
              .split(',')[0]
              .trim(),
          )}`
        : 'useExtracted';
      return extractFunction(ctx, { name: baseName, asMethod: false });
    }
    const base = /^use[A-Z]/.test(nameFromFileName(ctx.snapshot.fileName))
      ? nameFromFileName(ctx.snapshot.fileName)
      : `use${nameFromFileName(ctx.snapshot.fileName)}`;
    const name = uniqueName(
      ctx.declarations.topLevelNames.has(base) ? 'useCustom' : base,
      ctx.declarations.topLevelNames,
    );
    const generic = ctx.language.isTypeScript ? `<\${3:string}>` : '';
    const template = `export function \${1:${name}}(\${2}) {\n\tconst [\${4:state}, set\${4/(.*)/\${1:/capitalize}/}] = useState${generic}(\${5:undefined})${sc}\n\n\t$0\n\n\treturn { \${4}, set\${4/(.*)/\${1:/capitalize}/} }${sc}\n}`;
    return withReactImports(ctx, insertTopLevelSnippet(ctx, template, { position: 'after' }), ['useState']);
  },
});

export const createReactHook: CommandDefinition = defineCommand({
  id: 'codepilot.createReactHook',
  title: 'Create React Hook',
  category: 'react',
  description:
    'Lets you pick a built-in hook (useState, useEffect, useMemo, useCallback, useRef, useContext, useReducer) or a custom hook and inserts it context-aware.',
  keybinding: { key: 'ctrl+alt+shift+f2' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    return requireReact(ctx) ?? ok(20, 'Choose a hook to add');
  },
  async execute(ctx, ui) {
    const inComponent = !requireComponentBody(ctx);
    const items = [
      ...(inComponent
        ? [
            { label: 'useState', description: 'local state', value: createUseState },
            { label: 'useEffect', description: 'side effect with dependencies', value: createUseEffect },
            { label: 'useMemo', description: 'memoized value', value: createUseMemo },
            { label: 'useCallback', description: 'memoized callback', value: createUseCallback },
            { label: 'useRef', description: 'mutable ref / element ref', value: createUseRef },
            { label: 'useContext', description: 'read a context value', value: useContextCommand },
            { label: 'useReducer', description: 'reducer-based state', value: useReducerCommand },
          ]
        : []),
      { label: 'Custom hook', description: 'new useX() function', value: createCustomHook },
    ];
    const picked = await ui.pick(items, { title: 'Create React Hook', placeholder: 'Which hook?' });
    if (!picked) {
      return { cancelled: true };
    }
    return picked.execute(ctx, ui);
  },
});

const useContextCommand: CommandDefinition = defineCommand({
  id: 'codepilot.internal.useContext',
  title: 'useContext',
  category: 'react',
  description: 'internal',
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => requireReact(ctx) ?? requireComponentBody(ctx) ?? ok(0),
  async execute(ctx) {
    const sc = semi(ctx);
    const contexts = ctx.declarations.variables
      .filter((v) => /Context$/.test(v.name) || /createContext\(/.test(v.initializerText ?? ''))
      .map((v) => v.name);
    const ctxName = contexts.length ? `\${1|${contexts.join(',')}|}` : '${1:SomeContext}';
    return withReactImports(
      ctx,
      snippetAtPlan(ctx, hookPlan(ctx), `const \${2:value} = useContext(${ctxName})${sc}`),
      ['useContext'],
    );
  },
});

const useReducerCommand: CommandDefinition = defineCommand({
  id: 'codepilot.internal.useReducer',
  title: 'useReducer',
  category: 'react',
  description: 'internal',
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => requireReact(ctx) ?? requireComponentBody(ctx) ?? ok(0),
  async execute(ctx) {
    const sc = semi(ctx);
    return withReactImports(
      ctx,
      snippetAtPlan(
        ctx,
        hookPlan(ctx),
        `const [\${1:state}, dispatch] = useReducer(\${2:reducer}, \${3:initialState})${sc}`,
      ),
      ['useReducer'],
    );
  },
});

// ---------------------------------------------------------------------------
// F10 Props Interface
// ---------------------------------------------------------------------------

function targetComponent(ctx: CodeContext): ComponentInfo | undefined {
  if (ctx.react.enclosingComponent) {
    return ctx.react.enclosingComponent;
  }
  const decl = ctx.selection.kind === 'none' ? undefined : tsOf(ctx).selectedStatements[0];
  if (decl) {
    return ctx.react.components.find(
      (c) => c.range.start >= decl.getStart(tsOf(ctx).sourceFile) && c.range.end <= decl.getEnd(),
    );
  }
  return ctx.react.components.length === 1 ? ctx.react.components[0] : undefined;
}

function componentNode(ctx: CodeContext, comp: ComponentInfo) {
  const ast = tsOf(ctx);
  let found: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.getStart(ast.sourceFile) === comp.range.start
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(ast.sourceFile);
  return found;
}

export const createPropsInterface: CommandDefinition = defineCommand({
  id: 'codepilot.createPropsInterface',
  title: 'Create Props Interface',
  category: 'react',
  description:
    'Generates a Props interface for the enclosing component from its destructured props and `props.x` accesses, and annotates the parameter.',
  keybinding: { key: 'ctrl+alt+shift+f10' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx);
    if (gate) {
      return gate;
    }
    const comp = targetComponent(ctx);
    if (!comp) {
      return no('Place the cursor inside a React component.');
    }
    if (comp.propsTypeText && !/^\{/.test(comp.propsTypeText)) {
      return no(`${comp.name} already has typed props (${comp.propsTypeText}).`);
    }
    const count = comp.destructuredProps.length + comp.propsAccessed.length;
    return ok(
      count ? 70 : 35,
      `Create ${comp.name}Props with ${count} inferred propert${count === 1 ? 'y' : 'ies'}`,
    );
  },
  async execute(ctx) {
    const ast = tsOf(ctx);
    const sf = ast.sourceFile;
    const sc = semi(ctx);
    const comp = targetComponent(ctx);
    if (!comp) {
      throw new CodePilotError('unavailable', 'Place the cursor inside a React component.');
    }
    const node = componentNode(ctx, comp);
    const propNames = [...new Set([...comp.destructuredProps, ...comp.propsAccessed])];
    const interfaceName = uniqueName(`${comp.name}Props`, ctx.declarations.topLevelNames);
    const body = node?.body;
    const needsReactNode = propNames.includes('children');
    const propLines = propNames.map((p) => {
      let type = 'unknown';
      if (p === 'children') {
        type = 'ReactNode';
      } else if (/^on[A-Z]/.test(p)) {
        type = '() => void';
      } else if (body) {
        type = inferTypeFromUsage(p, body) ?? type;
        if (type === 'unknown') {
          const ref = collectValueReferences(body).get(p)?.[0];
          type = (ref && checkerTypeText(ast.getChecker(), ref)) ?? type;
        }
      }
      return { name: p, type };
    });
    // Inline type literal on the parameter: reuse its members verbatim.
    if (comp.propsTypeText && /^\{/.test(comp.propsTypeText) && node?.parameters[0]?.type) {
      const typeNode = node.parameters[0].type;
      const inner = ctx.text.slice(typeNode.getStart(sf) + 1, typeNode.getEnd() - 1).trim();
      const code = `interface ${interfaceName} {\n${inner
        .split(/;\s*|\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => `\t${l}${l.endsWith(';') ? '' : sc}`)
        .join('\n')}\n}`;
      const plan = planTopLevelInsertion(ctx, { position: 'before' });
      return {
        edits: [
          {
            range: plan.range,
            text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
          },
          { range: { start: typeNode.getStart(sf), end: typeNode.getEnd() }, text: interfaceName },
        ],
        message: `Extracted the inline props type into ${interfaceName}`,
      };
    }
    const isTs = ctx.language.isTypeScript;
    const code = isTs
      ? `interface ${interfaceName} {\n${propLines.map((p) => `\t${p.name}: ${p.type}${sc}`).join('\n') || '\t'}\n}`
      : `/**\n * @typedef {Object} ${interfaceName}\n${propLines.map((p) => ` * @property {${p.type === 'ReactNode' ? 'import("react").ReactNode' : p.type}} ${p.name}`).join('\n')}\n */`;
    const plan = planTopLevelInsertion(ctx, { position: 'before' });
    const edits: TextEdit[] = [
      {
        range: plan.range,
        text: plan.prefix + renderCode(code, ctx, plan.indent, plan.indentFirstLine) + plan.suffix,
      },
    ];
    const param = node?.parameters[0];
    if (param && !param.type) {
      if (isTs) {
        edits.push({
          range: { start: param.name.getEnd(), end: param.name.getEnd() },
          text: `: ${interfaceName}`,
        });
      }
    } else if (!param && node && isTs) {
      const paren = ctx.text.indexOf('(', node.getStart(sf));
      if (paren !== -1 && paren < (node.body?.getStart(sf) ?? ctx.text.length)) {
        edits.push({ range: { start: paren + 1, end: paren + 1 }, text: `props: ${interfaceName}` });
      }
    }
    const result: CommandResult = {
      edits,
      message: `Created ${interfaceName} with ${propLines.length} propert${propLines.length === 1 ? 'y' : 'ies'}`,
    };
    return needsReactNode && isTs ? withReactImports(ctx, result, [], ['ReactNode']) : result;
  },
});

// ---------------------------------------------------------------------------
// F11 Event Handler
// ---------------------------------------------------------------------------

function jsxAttributeAtCursor(ctx: CodeContext): ts.JsxAttribute | undefined {
  const ast = tsOf(ctx);
  let node: ts.Node | undefined = ast.selectedNode ?? ast.nodeAtCursor;
  while (node && !ts.isJsxAttribute(node) && !ts.isJsxOpeningLikeElement(node) && !ts.isStatement(node)) {
    node = node.parent;
  }
  return node && ts.isJsxAttribute(node) ? node : undefined;
}

export const createEventHandler: CommandDefinition = defineCommand({
  id: 'codepilot.createEventHandler',
  title: 'Create Event Handler',
  category: 'react',
  description:
    'Creates a typed event handler for the JSX attribute/element at the cursor (e.g. onClick on a <button> → React.MouseEvent<HTMLButtonElement>) and wires it up.',
  keybinding: { key: 'ctrl+alt+shift+f11' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx);
    if (gate) {
      return gate;
    }
    if (!ctx.react.enclosingComponent) {
      return no('Place the cursor inside a React component.');
    }
    const attr = jsxAttributeAtCursor(ctx);
    if (attr && ts.isIdentifier(attr.name) && /^on[A-Z]/.test(attr.name.text)) {
      return ok(85, `Create a handler for ${attr.name.text} on <${ctx.react.jsxTagName ?? 'element'}>`);
    }
    if (ctx.react.jsxTagName) {
      return ok(60, `Add an event handler to <${ctx.react.jsxTagName}>`);
    }
    return ok(25, 'Insert an event handler');
  },
  async execute(ctx, ui: UserInteraction) {
    const ast = tsOf(ctx);
    const sf = ast.sourceFile;
    const sc = semi(ctx);
    const isTs = ctx.language.isTypeScript;
    const attr = jsxAttributeAtCursor(ctx);
    const tag = ctx.react.jsxTagName;
    let eventName: string | undefined =
      attr && ts.isIdentifier(attr.name) && /^on[A-Z]/.test(attr.name.text) ? attr.name.text : undefined;
    const element = getEnclosingJsxElement(ast.nodeAtCursor);
    if (!eventName && element && !ts.isJsxFragment(element)) {
      const common =
        tag === 'form'
          ? ['onSubmit', 'onChange', 'onReset']
          : tag === 'input' || tag === 'textarea' || tag === 'select'
            ? ['onChange', 'onBlur', 'onFocus', 'onKeyDown']
            : ['onClick', 'onChange', 'onSubmit', 'onKeyDown', 'onMouseEnter', 'onFocus', 'onBlur'];
      const picked = await ui.pick(
        common.map((c) => ({ label: c, value: c })),
        { title: `Event handler for <${tag}>`, placeholder: 'Which event?' },
      );
      if (!picked) {
        return { cancelled: true };
      }
      eventName = picked;
    }
    const handlerBase = eventName ? `handle${eventName.slice(2)}` : 'handleClick';
    const handlerName = uniqueName(handlerBase, ctx.scope.visibleNames);
    const eventType = eventTypeFor(eventName ?? 'onClick', tag && /^[a-z]/.test(tag) ? tag : undefined);
    const preventDefault = eventName === 'onSubmit' ? `\tevent.preventDefault()${sc}\n` : '';
    const declaration = `const ${handlerName} = (event${isTs ? `: ${eventType}` : ''}) => {\n${preventDefault}\t$0\n}${sc}`;
    const comp = ctx.react.enclosingComponent;
    // Insert before the return statement of the component.
    let plan: InsertionPlan;
    const compNode = ast.enclosingComponentNode;
    const returnStmt =
      compNode?.body && ts.isBlock(compNode.body)
        ? compNode.body.statements.find(ts.isReturnStatement)
        : undefined;
    if (returnStmt && comp) {
      const start = returnStmt.getStart(sf);
      const indent = lineIndentAt(ctx.text, start);
      plan = { range: { start, end: start }, indent, prefix: '', suffix: ctx.eol + ctx.eol + indent };
    } else {
      plan = hookPlan(ctx);
    }
    const result = snippetAtPlan(ctx, plan, declaration);
    const edits: TextEdit[] = [];
    if (attr && ts.isIdentifier(attr.name) && attr.name.text === eventName) {
      if (attr.initializer) {
        edits.push({
          range: { start: attr.initializer.getStart(sf), end: attr.initializer.getEnd() },
          text: `{${handlerName}}`,
        });
      } else {
        edits.push({ range: { start: attr.getEnd(), end: attr.getEnd() }, text: `={${handlerName}}` });
      }
    } else if (element && !ts.isJsxFragment(element) && eventName) {
      const opening = ts.isJsxElement(element) ? element.openingElement : element;
      const existing = opening.attributes.properties.find(
        (p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === eventName,
      );
      if (!existing) {
        const pos = opening.tagName.getEnd();
        edits.push({ range: { start: pos, end: pos }, text: ` ${eventName}={${handlerName}}` });
      }
    }
    const imports = isTs ? ensureImports(ctx, reactNamespaceImport(ctx)) : { edits: [] as TextEdit[] };
    return {
      ...result,
      edits: [...edits, ...imports.edits],
      message: `Created ${handlerName}${eventName ? ` for ${eventName}` : ''}`,
    };
  },
});

// ---------------------------------------------------------------------------
// F12 JSX Element
// ---------------------------------------------------------------------------

export const createJsxElement: CommandDefinition = defineCommand({
  id: 'codepilot.createJsxElement',
  title: 'Create JSX Element',
  category: 'react',
  description: 'Wraps the selected JSX in a new element or inserts a JSX element at the cursor.',
  keybinding: { key: 'ctrl+alt+shift+f12' },
  supportedLanguages: JS_LANGUAGES,
  canExecute(ctx) {
    const gate = requireReact(ctx);
    if (gate) {
      return gate;
    }
    if (!ctx.language.isJsx) {
      return no('JSX elements need a .jsx or .tsx file.');
    }
    if (selectedJsx(ctx) || (ctx.selection.kind !== 'none' && ctx.react.inJsx)) {
      return ok(60, `Wrap ${describeSelection(ctx)} in a new element`);
    }
    if (ctx.selection.kind !== 'none') {
      return no('Select JSX to wrap, or clear the selection.');
    }
    return ok(ctx.react.inJsx ? 40 : 15, 'Insert a JSX element');
  },
  async execute(ctx) {
    const range = ctx.selection.range;
    if (ctx.selection.kind !== 'none') {
      const indent = lineIndentAt(ctx.text, range.start);
      const inner = escapeSnippet(ctx.text.slice(range.start, range.end));
      const multi = inner.includes('\n');
      const body = multi
        ? `<\${1:div}>${ctx.eol}${indent}${ctx.indent.unit}${inner.split(/\r?\n/).join(`${ctx.eol}${ctx.indent.unit}`)}${ctx.eol}${indent}</\${1}>`
        : `<\${1:div}>${inner}</\${1}>`;
      return { snippet: { range, body } };
    }
    if (ctx.react.inJsx) {
      return { snippet: { range: { start: ctx.cursor, end: ctx.cursor }, body: `<\${1:div}>$0</\${1}>` } };
    }
    return insertStatementSnippet(
      ctx,
      `const \${1:element} = (\n\t<\${2:div}>\n\t\t$0\n\t</\${2}>\n)${semi(ctx)}`,
    );
  },
});

export const reactCommands: CommandDefinition[] = [
  createReactComponent,
  createReactHook,
  createUseState,
  createUseEffect,
  createUseMemo,
  createUseCallback,
  createUseRef,
  createReactContext,
  createCustomHook,
  createPropsInterface,
  createEventHandler,
  createJsxElement,
];
