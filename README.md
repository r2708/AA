# CodePilot — context-aware coding shortcuts for VS Code

CodePilot is a keyboard-driven **coding command engine** for JavaScript and TypeScript (including JSX/TSX).
Every command analyses the current file first — language, AST, cursor position, selection, enclosing scope,
existing declarations and imports, project dependencies — and *then* decides what code to generate or how to
transform what you already wrote.

> **Understand the code first, then generate the appropriate code.**

## Why this is not a snippet extension

| Snippet extension | CodePilot |
| --- | --- |
| Inserts the same static text every time | Chooses between generating, extracting, converting or wrapping based on context |
| Ignores the selection | Extracts selected code into functions/variables/components with inferred parameters and types |
| Duplicates imports and declarations | Merges into existing imports, renames on collisions, refuses to duplicate a constructor or default export |
| Breaks indentation in nested code | Plans insertion positions from the AST and re-indents moved code |
| One template per language | Adapts to TypeScript vs JavaScript (interfaces vs JSDoc typedefs, enums vs frozen objects), quote/semicolon style, tabs/spaces, CRLF |

A few examples of the same shortcut doing different things:

```ts
// Shift+F1 (Create Function) with the cursor on this line…
const user = await getUser(id);
// …creates the missing function, async because the call is awaited, typed from the argument:
async function getUser(id: string): Promise<unknown> {
  |
}
```

```ts
// Shift+F1 with these two statements selected inside checkout(price: number, quantity: number)…
const total = price * quantity;
console.log(total);
// …extracts them (parameters inferred from usage and the enclosing signature):
calculateTotal(price, quantity);

function calculateTotal(price: number, quantity: number) {
  const total = price * quantity;
  console.log(total);
}
```

```ts
// Shift+F5 (Create Interface) with the object literal selected…
const user = { id: 1, name: 'John', address: { city: 'Oslo' }, tags: ['a'], nickname: undefined };
// …infers nested interfaces, arrays and optional properties and annotates the variable:
interface UserAddress {
  city: string;
}

interface User {
  id: number;
  name: string;
  address: UserAddress;
  tags: string[];
  nickname?: unknown;
}

const user: User = { … };
```

## Installation

- **Marketplace**: search for *CodePilot* in the Extensions view (once published), or
- **VSIX**: download `codepilot-<version>.vsix` and run `Extensions: Install from VSIX…`, or
- **From source**: see [Development setup](#development-setup) and press `F5`.

CodePilot activates on startup, shows a `CodePilot: ON` status bar item and registers its commands for
JavaScript, TypeScript, JSX and TSX editors.

## Supported languages

| Language id | Notes |
| --- | --- |
| `typescript`, `typescriptreact` | Full support: types are inferred and emitted |
| `javascript`, `javascriptreact` | Same commands; type-only output becomes JSDoc (`@typedef`, `@param {type}`), enums become frozen objects |

Other languages are rejected with a clear message. The analyzer is built around a `LanguageAdapter` interface so
Python/Java/Go/… adapters can be added later without touching the command layer (see
[Adding a language adapter](#adding-a-language-adapter)).

## Shortcuts

All keybindings are contributed through `package.json` and can be changed in *Preferences: Open Keyboard
Shortcuts* like any other VS Code command. They only fire when a JavaScript/TypeScript editor has focus, the file
is writable and `codepilot.enabled` is on. On macOS `Ctrl` means the Control key (not Cmd).

### Core (`Shift + F1…F12`)

| Key | Command | Context-aware behaviour |
| --- | --- | --- |
| Shift+F1 | Create Function | Selection → extract function/method · undeclared call on the line → stub with params/async/return type inferred · in class body → method · otherwise skeleton (arrow style if the file prefers arrows) |
| Shift+F2 | Create Variable | Selected expression → `const profileName = user.profile.name;` with naming from the expression, collision-safe · in class/object → property · otherwise `const/let` snippet |
| Shift+F3 | Create Constant | Selected literal → module-level `UPPER_CASE` constant after imports, duplicates replaced · expressions using locals stay local |
| Shift+F4 | Create Class | Interface at cursor/nearby → class implementing it (properties, constructor, method stubs) · selected object literal → class from its shape · several interfaces → Quick Pick |
| Shift+F5 | Create Interface | Object literal (selected or around cursor) → interface(s), nested/array/optional inference, variable annotated · class → extracted interface · JS → JSDoc typedef |
| Shift+F6 | Create Type | Object literal → type alias · `['a', 'b']` → string-literal union · interface → type conversion · expression → alias of its inferred type |
| Shift+F7 | Create Enum | String array / literal-union type / object of literals → enum (JS: `Object.freeze`) |
| Shift+F8 | Create Object | Interface/type at cursor → object literal with sample values for every required property (nested types resolved) |
| Shift+F9 | Create Array | Type at cursor → typed empty array · selected expression → wrapped in an array |
| Shift+F10 | Create Constructor | From the class's uninitialised properties, optional ones last, `super()` for subclasses, refuses duplicates |
| Shift+F11 | Create Method | Selection inside a method → extract private method (uses `this`) · otherwise method skeleton at the end of the class |
| Shift+F12 | Create Property | Class / interface / object literal aware insertion position and comma handling |

### Control flow (`Ctrl + Shift + F1…F12`)

| Key | Command | Context-aware behaviour |
| --- | --- | --- |
| Ctrl+Shift+F1 | Create If / Else | Wraps selected statements · selected expression becomes the condition |
| Ctrl+Shift+F2 | Create Switch | Generates a `case` per enum member or union literal when the type of the selected expression is known |
| Ctrl+Shift+F3 | Create For Loop | Iterates the selected or nearest array variable |
| Ctrl+Shift+F4 | Create For…Of | Singularised item name (`categories` → `category`) |
| Ctrl+Shift+F5 | Create For…In | Nearest object variable, `Object.hasOwn` guard |
| Ctrl+Shift+F6 | Create While Loop | Wrap or insert |
| Ctrl+Shift+F7 | Create Do…While | Wrap or insert |
| Ctrl+Shift+F8 | Create Try / Catch | Wraps the selection, or the awaited/risky statement at the cursor; unique `error` name |
| Ctrl+Shift+F9 | Create Try / Catch / Finally | Same, with `finally` |
| Ctrl+Shift+F10 | Create Throw Error | Offers custom `Error` subclasses from the file; re-throws inside `catch` |
| Ctrl+Shift+F11 | Create Return | JSX return in components, `return;` for `void`, selected expression as value |
| Ctrl+Shift+F12 | Create Ternary | Converts `if/else` with matching returns/assignments into a ternary |

### Imports, exports & expressions (`Alt + Shift + F1…F12`)

| Key | Command | Context-aware behaviour |
| --- | --- | --- |
| Alt+Shift+F1 | Create Import | Undeclared identifier → import from React, Node builtins or a project dependency, merged into an existing import from the same module |
| Alt+Shift+F2 | Create Named Import | Prefilled with the selected identifier |
| Alt+Shift+F3 | Create Default Import | Prefilled with the selected identifier |
| Alt+Shift+F4 | Create Export | Adds `export` to the declaration at the cursor (never twice) |
| Alt+Shift+F5 | Create Default Export | Declaration at cursor / single component; refuses a second default export |
| Alt+Shift+F6 | Create Re-export | Converts the selected import into an `export { } from` |
| Alt+Shift+F7 | Create Destructuring | Uses the members of the known interface / object literal |
| Alt+Shift+F8 | Create Spread | `[...items]` vs `{ ...config }` by type |
| Alt+Shift+F9 | Create Optional Chaining | `user.profile.name` → `user?.profile?.name` (roots like `this` stay) |
| Alt+Shift+F10 | Create Nullish Coalescing | `a \|\| b` → `a ?? b`, or appends `?? fallback` |
| Alt+Shift+F11 | Create Promise | Independent sequential `await`s → `Promise.all`; wraps statements in an executor |
| Alt+Shift+F12 | Create Async / Await | `.then(cb)` → `const x = await …`; awaits the selection and marks the function `async` |

### React (`Ctrl + Alt + Shift + F1…F12`, React files only)

| Key | Command | Context-aware behaviour |
| --- | --- | --- |
| Ctrl+Alt+Shift+F1 | Create React Component | Selected JSX → extracted component with props inferred from used variables · otherwise component named after the file with a props interface |
| Ctrl+Alt+Shift+F2 | Create React Hook | Quick Pick of built-in hooks / custom hook |
| Ctrl+Alt+Shift+F3 | Create useState | Typed from the selected initial value, inserted after existing hooks, import merged |
| Ctrl+Alt+Shift+F4 | Create useEffect | Moves selected statements into an effect with an inferred dependency array (async bodies wrapped) |
| Ctrl+Alt+Shift+F5 | Create useMemo | Memoizes the selected expression with inferred deps |
| Ctrl+Alt+Shift+F6 | Create useCallback | Wraps the selected/enclosing arrow function with inferred deps |
| Ctrl+Alt+Shift+F7 | Create useRef | On a JSX element: typed element ref (`useRef<HTMLInputElement>`) and `ref={…}` attached |
| Ctrl+Alt+Shift+F8 | Create React Context | Context + Provider + guarded `useX()` hook, `createElement` fallback in `.ts` files |
| Ctrl+Alt+Shift+F9 | Create Custom Hook | Extracts hook-using statements into `useX()` returning what is used afterwards |
| Ctrl+Alt+Shift+F10 | Create Props Interface | From destructured props / `props.x` usage, types inferred from usage, `children: ReactNode` |
| Ctrl+Alt+Shift+F11 | Create Event Handler | `onSubmit` on `<form>` → `React.FormEvent<HTMLFormElement>` handler wired to the attribute |
| Ctrl+Alt+Shift+F12 | Create JSX Element | Wraps selected JSX or inserts an element |

### Backend (`Ctrl + Alt + F1…F12`)

The framework is detected from the file's imports first, then `package.json` (Express, Fastify, Koa, Hono,
Next.js, NestJS, hapi). When nothing is detected you are asked once via Quick Pick — Express is never assumed.

| Key | Command |
| --- | --- |
| Ctrl+Alt+F1 | Create API Route (router / plugin / route handlers module) |
| Ctrl+Alt+F2 | Create Controller (named after the file, e.g. `user.controller.ts` → `UserController`) |
| Ctrl+Alt+F3 | Create Service (typed with the entity interface in the file) |
| Ctrl+Alt+F4 | Create Middleware |
| Ctrl+Alt+F5 | Create Repository (in-memory, typed) |
| Ctrl+Alt+F6…F10 | Create GET / POST / PUT / PATCH / DELETE Endpoint (uses the router variable declared in the file) |
| Ctrl+Alt+F11 | Create API Handler |
| Ctrl+Alt+F12 | Create Error Handler (Express 4-arg middleware, Fastify `setErrorHandler`, Nest exception filter, …) |

### Testing (`Ctrl + Shift + Alt + F1…F12`)

Jest, Vitest, Mocha/Chai, Playwright and `node:test` are detected from imports and `package.json`; Jest-style
globals are the fallback. Framework imports are added only when the framework needs them.

| Key | Command |
| --- | --- |
| Ctrl+Shift+Alt+F1 | Create Test (test files only) |
| Ctrl+Shift+Alt+F2 | Create Test Suite |
| Ctrl+Shift+Alt+F3 | Create Assertion (`expect`, `chai` or `node:assert` style) |
| Ctrl+Shift+Alt+F4 | Create Mock (mocks the module of the import at the cursor) |
| Ctrl+Shift+Alt+F5 | Create Spy (on the selected `object.method`) |
| Ctrl+Shift+Alt+F6…F9 | Create beforeEach / afterEach / beforeAll / afterAll |
| Ctrl+Shift+Alt+F10 | Generate Test (sibling `.test`/`.spec` file with calls pre-filled from the signature) |
| Ctrl+Shift+Alt+F11 | Generate Test Data (sample object for an interface / sample arguments for a function) |
| Ctrl+Shift+Alt+F12 | Generate Mock Data (`createMockUser(overrides)` factory) |

### Refactoring (`Ctrl + Alt + Shift + letter`, also in the palette)

| Key | Command |
| --- | --- |
| Ctrl+Alt+Shift+E | Extract Function |
| Ctrl+Alt+Shift+V | Extract Variable |
| Ctrl+Alt+Shift+C | Extract Constant |
| Ctrl+Alt+Shift+I | Generate Import |
| Ctrl+Alt+Shift+T | Generate Type |
| Ctrl+Alt+Shift+N | Generate Interface |
| Ctrl+Alt+Shift+D | Generate Documentation (JSDoc with `@param`/`@returns`/`@throws`) |
| Ctrl+Alt+Shift+W | Wrap With Try/Catch |
| Ctrl+Alt+Shift+Y | Wrap With If |
| Ctrl+Alt+Shift+L | Wrap With Loop |

### Smart Action (`Ctrl + Shift + Space`)

Analyses the cursor/selection, asks every registered command whether it applies and how relevant it is, ranks
the answers (test files boost testing commands, React files boost hooks, selections boost refactorings) and shows
only the useful ones in a Quick Pick with a one-line description of what each would do — never the full list.

```
CodePilot Smart Action                       (selection: two awaited statements)
> Extract Function       Extract 2 statements into function fetchData(url)
  Create Try / Catch     Wrap 2 statements in try/catch
  Create Promise         Run 2 independent awaits in parallel with Promise.all
  Create Custom Hook     …
```

## Command Palette

Every command is available as `CodePilot: <Title>` (88 commands). Language-specific commands are hidden from the
palette in unsupported files. Meta commands: `CodePilot: Smart Action`, `Enable / Disable`, `Show All Commands`,
`Open Settings`, `Show Output Log`, `Status Menu` (also reachable by clicking the status bar item).

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `codepilot.enabled` | `true` | Master switch (also disables keybindings via the `codepilot.enabled` context key) |
| `codepilot.smartMode` | `true` | Enable Smart Action |
| `codepilot.react.enabled` | `true` | React command group |
| `codepilot.backend.enabled` | `true` | Backend command group |
| `codepilot.testing.enabled` | `true` | Testing command group |
| `codepilot.refactoring.enabled` | `true` | Refactoring command group |
| `codepilot.formatAfterGeneration` | `true` | Run the range formatter over code changed by plain-edit transformations (skipped while a snippet with tab stops is active so your cursor is not disturbed) |
| `codepilot.showNotifications` | `true` | Short status-bar confirmations after commands |
| `codepilot.logLevel` | `info` | Verbosity of the *CodePilot* output channel |

## Keybinding conflicts

The requested shortcuts overlap a few VS Code / OS defaults. CodePilot never removes a default binding; it adds
its own with `when` clauses (`editorTextFocus && !editorReadonly && codepilot.enabled && editorLangId in codepilot.supportedLanguages`)
and, where relevant, `!inDebugMode`. Rebind anything you dislike in *Keyboard Shortcuts* (search `codepilot`).

| CodePilot key | Conflicts with | Mitigation |
| --- | --- | --- |
| Shift+F5 | Stop debugging | CodePilot binding excluded while `inDebugMode` |
| Shift+F11 | Step out | Excluded while `inDebugMode` |
| Shift+F12 | Go to References | CodePilot wins in JS/TS editors; use `Shift+Alt+F12` (Find All References) or rebind |
| Shift+F10 | Context menu (Windows/Linux) | Rebind if you use the keyboard context menu |
| Ctrl+Shift+F5 | Restart debugging | Only when not debugging |
| Ctrl+Shift+F10 | Peek Definition | Rebind if needed |
| Ctrl+Shift+Space | Trigger Parameter Hints (Windows/Linux) | Rebind Smart Action (e.g. `Ctrl+Alt+Space`) if you rely on the default |
| Ctrl+Alt+F1…F12 | Virtual terminal switch on some Linux desktops | Rebind on those systems |
| macOS F-keys | Hardware functions unless "Use F1, F2… as standard function keys" is enabled | Enable the option or rebind |

## Examples

**Create Variable** — selection `user.profile.name` inside `console.log(...)`:

```ts
const profileName = user.profile.name;
console.log(profileName);
```

**Create Switch** — selection `status` where `status: Status` is an enum parameter:

```ts
switch (status) {
  case Status.Active:
    break;
  case Status.Done:
    break;
  default:
    break;
}
```

**Create Promise** — two independent awaited declarations selected:

```ts
const [a, b] = await Promise.all([loadA(), loadB()]);
```

**Create Async / Await** — a `.then()` statement selected in a non-async function:

```ts
async function load() {
  const user = await fetchUser();
  console.log(user);
}
```

**Create useRef** with the cursor on `<input type="text" />`:

```tsx
const inputRef = useRef<HTMLInputElement>(null);
…
<input ref={inputRef} type="text" />
```

**Generate Test** with the cursor inside `calculateTotal(price: number, quantity: number)` in a Vitest project
creates `math.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { calculateTotal } from './math';

describe('calculateTotal', () => {
  it('calculateTotal returns the expected result', async () => {
    const result = await calculateTotal(9.99, 3);
    expect(result).toBe(0);
  });
});
```

## Architecture

```
Keyboard shortcut / palette
        ↓
vscode/commandRunner.ts        editor → DocumentSnapshot (text, selection, indent, EOL, project info)
        ↓
analyzer/contextAnalyzer.ts    language detection → LanguageAdapter
        ↓
languages/typescript/…         TypeScript compiler API: AST, declarations, scope, selection, React, style
        ↓
CodeContext                    one structured object handed to every command
        ↓
commands/*  (CommandRegistry)  canExecute(ctx) → Applicability {available, score, detail}
                               execute(ctx, ui) → CommandResult {edits, snippet, newFile, message}
        ↓
generators/ + transformations/ pure code emitters (interfaces, classes, tests…) and AST-based transformations
        ↓
vscode/editorBridge.ts         WorkspaceEdit + insertSnippet(keepWhitespace) + optional range formatting
```

Design rules:

- **Pure core.** Nothing under `analyzer/`, `generators/`, `transformations/`, `commands/` or `smart/` imports
  `vscode`; they operate on offsets and return edits. That is why the whole engine is unit-tested in plain Node.
- **Deterministic.** No LLM is involved. Type inference uses a single-file TypeScript program with a tiny synthetic
  lib (fast, no disk access) plus usage heuristics (`price * quantity` → `number`).
- **Analyse on demand.** Parsing happens when a command runs; the `SourceFile` is cached per document version,
  `package.json` lookups are cached per directory with a 60 s TTL. Nothing runs on keystrokes.
- **Never corrupt code.** Insertion positions come from the AST (`transformations/insertion.ts`), moved code is
  re-indented, duplicate names are avoided, ambiguous situations ask via Quick Pick, and every command reports an
  honest reason when it does not apply.
- **Single source of truth.** `scripts/sync-manifest.js` regenerates `package.json` contributions from the command
  registry; `tests/manifest.test.ts` fails if they drift.

Folder layout:

```
src/
├── extension.ts               activation, command wiring, public API (registerAIProvider, registerLanguageAdapter, registerCommand)
├── types/                     CodeContext, CommandDefinition, CommandResult
├── analyzer/                  languageDetector, astAnalyzer, scopeAnalyzer, reactAnalyzer, typeInference, naming, projectDetector, contextAnalyzer
├── languages/                 LanguageAdapter interface + registry, typescript/ adapter
├── generators/                codeWriter, interface/class/function/doc/test/data/backend generators
├── transformations/           insertion planning, importManager, extractFunction, extractVariable, wrap, convert
├── commands/                  commandRegistry + core/ controlFlow/ imports/ react/ backend/ testing/ refactoring/
├── smart/                     actionScorer, smartAction
├── ai/                        AIProvider interface + registry (optional, no provider bundled)
├── config/                    settings schema + defaults
├── ui/                        status bar, Quick Pick adapter, output channel
└── vscode/                    editor bridge, command runner, project info provider, settings reader
tests/                         mocha unit tests mirroring the structure (analyzer, commands, transformations, smart, manifest)
```

## Development setup

```bash
npm install
npm run compile        # tsc → out/ (used by tests)
npm run watch          # incremental compile
npm run bundle         # esbuild → dist/extension.js (what VS Code loads)
npm run lint           # eslint (typescript-eslint, strict)
npm run format         # prettier
npm test               # compile + mocha (186 tests, ~0.2 s)
npm run sync-manifest  # regenerate package.json contributes from the registry
```

Press `F5` in VS Code to launch an Extension Development Host (`.vscode/launch.json` bundles first).

> If `npm install` times out on networks where IPv4 connections are slow, run it with
> `NODE_OPTIONS=--no-network-family-autoselection`.

## Testing

Tests live in `tests/` and run in plain Node (no VS Code download needed). The harness in
`tests/helpers/harness.ts` builds a `CodeContext` from annotated source — `<|>` marks the cursor, `[[ … ]]` the
selection — runs a command with a scripted Quick Pick, applies the returned edits and resolves snippet placeholders,
so tests assert on the final document text:

```ts
const { text } = await run(createVariable, `function f(user) {\n  console.log([[user.profile.name]]);\n}`);
assert.ok(text.includes('const profileName = user.profile.name;'));
```

Covered: context/scope/selection detection, naming, type inference, every command group (positive and negative
cases), duplicate import/declaration prevention, indentation/CRLF/tab preservation, malformed code, Smart Action
ranking and manifest consistency.

## Packaging & publishing

```bash
npm run package        # compile + lint + bundle + vsce package --no-dependencies → codepilot-<version>.vsix
```

The bundle includes the TypeScript compiler API, so the VSIX has no runtime `node_modules`. To publish:

1. Create a publisher on <https://marketplace.visualstudio.com/manage> and set `publisher` in `package.json`
   (currently the placeholder `codepilot-dev`) and the repository URL.
2. `npx vsce login <publisher>` with a Personal Access Token (Marketplace → Manage scope).
3. `npx vsce publish` (or `npx vsce publish patch|minor|major`).

## Extending CodePilot

### Adding a command

1. Create a `CommandDefinition` with `defineCommand({...})` in the matching `src/commands/<group>/` file:
   `id`, `title`, `category`, `description`, optional `keybinding`, `supportedLanguages`, `canExecute(ctx)` returning
   `{ available, score, detail }` and `execute(ctx, ui)` returning edits/snippet.
2. Add it to the group's exported array (it is then registered, ranked by Smart Action and contributed to the
   manifest automatically).
3. Run `npm run sync-manifest` and add tests under `tests/commands/`.

Other extensions can register commands at runtime through the API returned by `activate()`:
`vscode.extensions.getExtension('codepilot-dev.codepilot')?.exports.registerCommand(def)`.

### Adding a language adapter

Implement `LanguageAdapter` (`src/languages/languageAdapter.ts`): `languageIds` and
`analyze(snapshot, language): CodeContext`. Fill the generic parts of `CodeContext` (declarations, scope,
selection, style) and put your parser's payload in `ctx.ast`. Register it with `analyzer.languages.register(adapter)`
(or `exports.registerLanguageAdapter` from another extension) and give your commands `supportedLanguages`
containing your language ids.

### Adding an AI provider

Implement `AIProvider` (`src/ai/aiProvider.ts`): `explainCode`, `generateCode`, `fixCode`, `refactorCode`,
`optimizeCode`, `generateTests`, `generateDocumentation`, each receiving the code plus a slice of the `CodeContext`.
Register it via `exports.registerAIProvider(provider)`. The abstraction is ready for local Ollama, OpenAI, Anthropic
or any compatible API, but **no provider ships with CodePilot and no command depends on one** — everything above is
deterministic.

## Roadmap

- AI-backed commands (explain / fix / optimise) on top of the provider abstraction, opt-in only
- Additional language adapters (Python first)
- Multi-file awareness (imports resolved against workspace symbols)

## License

MIT
