import { assert, expectUnavailable, run } from '../helpers/harness';
import {
  createArray,
  createClass,
  createConstant,
  createConstructor,
  createEnum,
  createFunction,
  createInterface,
  createMethod,
  createObject,
  createProperty,
  createType,
  createVariable,
} from '../../src/commands/core/coreCommands';

describe('Create Function', () => {
  it('stubs an undeclared awaited call with parameters inferred from arguments', async () => {
    const { text, result } = await run(
      createFunction,
      `async function load(id: string) {\n  const user = await getUser(id);<|>\n  return user;\n}\n`,
    );
    assert.ok(text.includes('async function getUser(id: string): Promise<unknown> {'), text);
    assert.ok(text.indexOf('async function getUser') > text.indexOf('async function load'));
    assert.ok(/inferred from the call/.test(result.message ?? ''));
  });

  it('uses the declared variable type as the stub return type', async () => {
    const { text } = await run(
      createFunction,
      `interface User { id: string }\nasync function load(id: string) {\n  const user: User = await getUser(id);<|>\n}\n`,
    );
    assert.ok(text.includes('async function getUser(id: string): Promise<User> {'), text);
  });

  it('does not stub calls to declared or imported functions', async () => {
    const { text } = await run(
      createFunction,
      `import { getUser } from './api';\nasync function load(id: string) {\n  const user = await getUser(id);<|>\n}\n`,
      { picks: ['Top-level'] },
    );
    assert.ok(!text.includes('function getUser'));
    assert.ok(text.includes('function newFunction()'));
  });

  it('extracts selected statements into a function with typed parameters', async () => {
    const { text } = await run(
      createFunction,
      `function checkout(price: number, quantity: number) {\n[[  const total = price * quantity;\n  console.log(total);\n]]}\n`,
    );
    assert.ok(
      text.includes(
        'function checkout(price: number, quantity: number) {\n  calculateTotal(price, quantity);\n}',
      ),
      text,
    );
    assert.ok(
      text.includes(
        'function calculateTotal(price: number, quantity: number) {\n  const total = price * quantity;\n  console.log(total);\n}',
      ),
      text,
    );
  });

  it('creates a method when the cursor is inside a class body', async () => {
    const { text } = await run(createFunction, `class Service {\n  private items = [];\n<|>\n}\n`);
    assert.ok(text.includes('  newMethod() {\n    \n  }'), text);
  });

  it('inserts a skeleton at top level respecting arrow style', async () => {
    const { text } = await run(createFunction, `const a = () => 1;\nconst b = () => 2;\n<|>\n`);
    assert.ok(text.includes('const newFunction = () => {'), text);
  });

  it('avoids duplicate names', async () => {
    const { text } = await run(createFunction, `function newFunction() {}\n<|>\n`);
    assert.ok(text.includes('function newFunction2()'), text);
  });

  it('is unavailable inside JSX', () => {
    const reason = expectUnavailable(createFunction, `function App() { return <div><|></div>; }`, {
      languageId: 'typescriptreact',
    });
    assert.ok(/JSX/.test(reason));
  });

  it('refuses partial selections', () => {
    expectUnavailable(createFunction, `const a = [[user.pro]]file;`);
  });
});

describe('Create Variable', () => {
  it('extracts a property access with a derived name', async () => {
    const { text } = await run(
      createVariable,
      `function f(user) {\n  console.log([[user.profile.name]]);\n}`,
    );
    assert.ok(text.includes('  const profileName = user.profile.name;\n  console.log(profileName);'), text);
  });

  it('keeps the await when extracting an awaited call and picks a name from the callee', async () => {
    const { text } = await run(
      createVariable,
      `async function f(id: string) {\n  return [[await getUser(id)]];\n}`,
    );
    assert.ok(text.includes('  const user = await getUser(id);\n  return user;'), text);
  });

  it('avoids collisions with visible names', async () => {
    const { text } = await run(
      createVariable,
      `function f(user, profileName) {\n  console.log([[user.profile.name]]);\n}`,
    );
    assert.ok(text.includes('const profileName2 = user.profile.name;'), text);
  });

  it('turns a selected expression statement into a declaration', async () => {
    const { text } = await run(createVariable, `async function f() {\n  [[await fetch(url)]];\n}`);
    assert.ok(text.includes('const response = await fetch(url);'), text);
  });

  it('refuses to extract a direct initializer', async () => {
    const ctx = await run(createVariable, `const a = 1;`).catch(() => undefined);
    void ctx;
    await assert.rejects(run(createVariable, `const total = [[price * quantity]];`), /already assigned/);
  });

  it('inserts a declaration snippet with const/let choice on an empty line', async () => {
    const { text } = await run(createVariable, `function f() {\n  <|>\n}`);
    assert.strictEqual(text, `function f() {\n  const value = undefined;\n}`);
  });

  it('respects tab indentation', async () => {
    const { text } = await run(createVariable, `function f() {\n\tconsole.log([[a.b]]);\n}`, {
      useTabs: true,
    });
    assert.ok(text.includes('\tconst b = a.b;\n\tconsole.log(b);'), text);
  });
});

describe('Create Constant', () => {
  it('hoists a string literal to a module constant after imports and replaces duplicates', async () => {
    const { text, result } = await run(
      createConstant,
      `import x from 'x';\n\nfunction a() { return fetch([['https://api.example.com']]); }\nfunction b() { return fetch('https://api.example.com'); }\n`,
    );
    assert.ok(
      text.includes("import x from 'x';\n\nconst HTTPS_API_EXAMPLE_COM = 'https://api.example.com';\n"),
      text,
    );
    assert.ok(text.includes('function a() { return fetch(HTTPS_API_EXAMPLE_COM); }'), text);
    assert.ok(text.includes('function b() { return fetch(HTTPS_API_EXAMPLE_COM); }'), text);
    assert.ok(/replaced 1 other occurrence/.test(result.message ?? ''));
  });

  it('keeps expressions with local references local', async () => {
    const { text, result } = await run(createConstant, `function f(a: number) {\n  return [[a * 2]] + 1;\n}`);
    assert.ok(text.includes('  const product = a * 2;\n  return product + 1;'), text);
    assert.ok(/kept local/.test(result.message ?? ''));
  });

  it('inserts a constant skeleton at module level', async () => {
    const { text } = await run(createConstant, `import a from 'a';\n\nfunction f() {\n  <|>\n}`);
    assert.ok(text.startsWith(`import a from 'a';\n\nconst CONSTANT_NAME = value;\n\nfunction f()`), text);
  });
});

describe('Create Class', () => {
  it('implements the interface at the cursor', async () => {
    const { text } = await run(
      createClass,
      `export interface User {\n  id: string;\n  name: string;\n  email?: string;\n  greet(): string;\n}<|>\n`,
    );
    assert.ok(text.includes('export class UserImpl implements User {'), text);
    assert.ok(
      text.includes(
        '  id: string;\n  name: string;\n  email?: string;\n\n  constructor(id: string, name: string, email?: string) {\n    this.id = id;\n    this.name = name;\n    this.email = email;\n  }',
      ),
      text,
    );
    assert.ok(
      text.includes("  greet(): string {\n    throw new Error('Method not implemented.');\n  }"),
      text,
    );
  });

  it('strips an I-prefix from interface names', async () => {
    const { text } = await run(createClass, `interface IRepo { find(): void }<|>`);
    assert.ok(text.includes('class Repo implements IRepo'), text);
  });

  it('creates a class from a selected object literal', async () => {
    const { text } = await run(createClass, `const point = [[{ x: 1, y: 2, label: 'origin' }]];`);
    assert.ok(text.includes('class Point {\n  x: number;\n  y: number;\n  label: string;'), text);
  });

  it('asks which interface to implement when several exist', async () => {
    const { text, ui } = await run(
      createClass,
      `interface A { a: string }\ninterface B { b: number }\n\nconst x = 1;\n<|>\n`,
      { picks: ['Implement B'] },
    );
    assert.ok(ui.asked[0].labels?.includes('Empty class'));
    assert.ok(text.includes('class BImpl implements B'), text);
  });

  it('falls back to a skeleton in JavaScript', async () => {
    const { text } = await run(createClass, `<|>`, { languageId: 'javascript' });
    assert.ok(text.includes('class NewClass {\n  constructor(value) {\n    this.value = value;\n  }'), text);
  });

  it('respects existing names', async () => {
    const { text } = await run(createClass, `class NewClass {}\n<|>`, { languageId: 'javascript' });
    assert.ok(text.includes('class NewClass2'), text);
  });
});

describe('Create Interface', () => {
  it('infers an interface from a selected object literal and annotates the variable', async () => {
    const { text } = await run(
      createInterface,
      `const user = [[{\n  id: 1,\n  name: 'John',\n  active: true,\n  tags: ['a'],\n  address: { city: 'X', zip: 10 },\n  nickname: undefined,\n}]];\n`,
    );
    assert.ok(
      text.startsWith(
        'interface UserAddress {\n  city: string;\n  zip: number;\n}\n\ninterface User {\n  id: number;\n  name: string;\n  active: boolean;\n  tags: string[];\n  address: UserAddress;\n  nickname?: unknown;\n}\n\nconst user: User = {',
      ),
      text,
    );
  });

  it('infers optional properties and unions from arrays of objects', async () => {
    const { text } = await run(
      createInterface,
      `const rows = [[{ items: [{ id: 1, label: 'a' }, { id: 'x' }] }]];`,
    );
    assert.ok(text.includes('interface RowsItem {\n  id: number | string;\n  label?: string;\n}'), text);
    assert.ok(text.includes('interface Rows {\n  items: RowsItem[];\n}'), text);
  });

  it('works with the cursor inside the object literal', async () => {
    const { text } = await run(
      createInterface,
      `function f() {\n  const options = { retries: 3, <|>verbose: false };\n}`,
    );
    assert.ok(
      text.startsWith('interface Options {\n  retries: number;\n  verbose: boolean;\n}\n\nfunction f()'),
      text,
    );
  });

  it('emits a JSDoc typedef in JavaScript files', async () => {
    const { text } = await run(createInterface, `const user = [[{ id: 1, name: 'x' }]];`, {
      languageId: 'javascript',
    });
    assert.ok(
      text.startsWith(
        '/**\n * @typedef {Object} User\n * @property {number} id\n * @property {string} name\n */\n\nconst user = {',
      ),
      text,
    );
  });

  it('extracts an interface from a class', async () => {
    const { text } = await run(
      createInterface,
      `[[class Repo {\n  private cache = new Map();\n  items: string[] = [];\n  find(id: string): string { return id; }\n}]]`,
    );
    assert.ok(text.includes('interface IRepo {\n  items: string[];\n  find(id: string): string;\n}'), text);
    assert.ok(text.includes('class Repo implements IRepo {'), text);
  });

  it('avoids duplicate interface names', async () => {
    const { text } = await run(createInterface, `interface User { id: string }\nconst user = [[{ id: 1 }]];`);
    assert.ok(text.includes('interface User2 {\n  id: number;\n}'), text);
  });

  it('refuses a non-object selection', () => {
    expectUnavailable(createInterface, `const a = [[1 + 2]];`);
  });
});

describe('Create Type', () => {
  it('creates a union type from a string array and annotates it', async () => {
    const { text } = await run(createType, `const roles = [[ ['admin', 'user'] ]];`);
    assert.ok(text.startsWith(`type Role = 'admin' | 'user';\n\nconst roles: Role[] =`), text);
  });

  it('converts an interface to a type alias', async () => {
    const { text } = await run(createType, `export [[interface A extends B {\n  x: string;\n}]]`);
    assert.strictEqual(text, `export type A = B & {\n  x: string;\n};`);
  });

  it('creates a type alias from an inferred expression type', async () => {
    const { text } = await run(createType, `const total = [[1 + 2]];`);
    assert.strictEqual(text, `type Total = number;\n\nconst total: Total = 1 + 2;`);
  });

  it('is unavailable in JavaScript', () => {
    expectUnavailable(createType, `<|>`, { languageId: 'javascript' });
  });
});

describe('Create Enum', () => {
  it('creates an enum from a string array', async () => {
    const { text } = await run(createEnum, `const statuses = [[ ['active', 'in-progress'] ]];`);
    assert.ok(
      text.startsWith(
        `enum Status {\n  Active = 'active',\n  InProgress = 'in-progress',\n}\n\nconst statuses`,
      ),
      text,
    );
  });

  it('converts a literal union type alias', async () => {
    const { text } = await run(createEnum, `export type Direction = 'up' | 'down';<|>`);
    assert.strictEqual(text, `export enum Direction {\n  Up = 'up',\n  Down = 'down',\n}`);
  });

  it('emits a frozen object in JavaScript', async () => {
    const { text } = await run(createEnum, `const colors = [[ ['red', 'green'] ]];`, {
      languageId: 'javascript',
    });
    assert.ok(text.startsWith(`const Color = Object.freeze({\n  Red: 'red',\n  Green: 'green',\n});`), text);
  });
});

describe('Create Object / Array', () => {
  it('creates an object with sample values for the interface at the cursor', async () => {
    const { text } = await run(
      createObject,
      `interface User {\n  id: number;\n  email: string;\n  active: boolean;\n  nickname?: string;\n  tags: string[];\n}<|>\n`,
    );
    assert.ok(
      text.includes(
        `const user: User = {\n  id: 1,\n  email: 'user@example.com',\n  active: true,\n  tags: [],\n};`,
      ),
      text,
    );
  });

  it('resolves nested interfaces', async () => {
    const { text } = await run(
      createObject,
      `interface Address { city: string }\ninterface User {\n  id: number;\n  address: Address;\n}<|>`,
    );
    assert.ok(
      text.includes(`const user: User = {\n  id: 1,\n  address: {\n    city: 'city',\n  },\n};`),
      text,
    );
  });

  it('creates a typed array for a selected type name', async () => {
    const { text } = await run(
      createArray,
      `interface User { id: number }\nfunction f() {\n  const x: [[User]] = { id: 1 };\n}`,
    );
    assert.ok(text.includes('const users: User[] = [];'), text);
  });

  it('inserts an array skeleton', async () => {
    const { text } = await run(createArray, `<|>`);
    assert.strictEqual(text, 'const items: string[] = [];');
  });
});

describe('Create Constructor / Method / Property', () => {
  it('generates a constructor from uninitialised properties', async () => {
    const { text } = await run(
      createConstructor,
      `class User {\n  id: string;\n  name?: string;\n  readonly createdAt: Date;\n  count = 0;\n  static instances = 0;\n\n  greet() {}<|>\n}`,
    );
    assert.ok(
      text.includes(
        '  count = 0;\n  static instances = 0;\n\n  constructor(id: string, createdAt: Date, name?: string) {\n    this.id = id;\n    this.createdAt = createdAt;\n    this.name = name;\n    \n  }\n\n  greet() {}',
      ),
      text,
    );
  });

  it('calls super() for subclasses', async () => {
    const { text } = await run(createConstructor, `class Admin extends User {\n  level: number;<|>\n}`);
    assert.ok(text.includes('constructor(level: number) {\n    super();\n    this.level = level;'), text);
  });

  it('refuses when a constructor exists', () => {
    const reason = expectUnavailable(createConstructor, `class A {\n  constructor() {}\n  <|>\n}`);
    assert.ok(/already has a constructor/.test(reason));
  });

  it('extracts selected statements into a private method using this', async () => {
    const { text } = await run(
      createMethod,
      `class Cart {\n  items: number[] = [];\n  total() {\n[[    const sum = this.items.reduce((a, b) => a + b, 0);\n    console.log(sum);\n]]    return 1;\n  }\n}`,
    );
    assert.ok(
      text.includes(
        '  total() {\n    this.getSum();\n    return 1;\n  }\n\n  private getSum() {\n    const sum = this.items.reduce((a, b) => a + b, 0);\n    console.log(sum);\n  }',
      ),
      text,
    );
  });

  it('adds a method at the end of the class', async () => {
    const { text } = await run(createMethod, `class A {\n  x = 1;\n  m() {<|>}\n}`);
    assert.ok(text.includes('  m() {}\n\n  newMethod() {\n    \n  }\n}'), text);
  });

  it('adds a property after existing properties', async () => {
    const { text } = await run(createProperty, `class A {\n  x = 1;\n\n  m() {<|>}\n}`);
    assert.ok(text.includes('  x = 1;\n  private property: string;\n\n  m() {}'), text);
  });

  it('adds an interface member', async () => {
    const { text } = await run(createProperty, `interface A {\n  x: number;<|>\n}`);
    assert.strictEqual(text, `interface A {\n  x: number;\n  property: string;\n}`);
  });

  it('adds an object literal property with comma handling', async () => {
    const { text } = await run(createProperty, `const o = {\n  a: 1<|>\n};`);
    assert.strictEqual(text, `const o = {\n  a: 1,\n  key: value,\n};`);
  });

  it('is unavailable outside of containers', () => {
    expectUnavailable(createProperty, `const a = 1;<|>`);
    expectUnavailable(createMethod, `function f() {<|>}`);
  });
});
