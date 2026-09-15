import { assert, expectUnavailable, run } from '../helpers/harness';
import {
  createAssertion,
  createBeforeEach,
  createMock,
  createSpy,
  createTest,
  createTestSuite,
  generateMockData,
  generateTest,
  generateTestData,
} from '../../src/commands/testing/testingCommands';

const TEST_FILE = { fileName: '/p/src/math.test.ts' };

describe('testing commands', () => {
  it('inserts a jest-style test in a test file', async () => {
    const { text } = await run(createTest, `describe('math', () => {\n  <|>\n});`, TEST_FILE);
    assert.strictEqual(
      text,
      `describe('math', () => {\n  it('does something', async () => {\n    \n    expect(actual).toBe(expected);\n  });\n});`,
    );
  });

  it('uses vitest syntax and imports', async () => {
    const { text } = await run(createTestSuite, `import { describe } from 'vitest';\n\n<|>`);
    assert.ok(text.startsWith(`import { describe, it } from 'vitest';`), text);
    assert.ok(text.includes(`describe('file', () => {\n  it('does something', () => {`), text);
  });

  it('uses chai assertions with mocha and node:assert with node:test', async () => {
    const chai = await run(createAssertion, `import { expect } from 'chai';\nconst result = 1;\n[[result]];`);
    assert.ok(chai.text.endsWith(`expect(result).to.equal(expected);`), chai.text);
    const node = await run(
      createAssertion,
      `import { describe } from 'node:test';\nconst result = 1;\n[[result]];`,
    );
    assert.ok(node.text.endsWith(`assert.strictEqual(result, expected);`), node.text);
    assert.ok(node.text.includes(`import assert from 'node:assert/strict';`), node.text);
  });

  it('mocks the module of the import at the cursor', async () => {
    const jest = await run(createMock, `import { api } from './a<|>pi';\n\ntest('x', () => {});`, TEST_FILE);
    assert.ok(jest.text.includes(`import { api } from './api';\n\njest.mock('./api');\n`), jest.text);
    const vitest = await run(
      createMock,
      `import { vi } from 'vitest';\nimport { api } from './a<|>pi';\n`,
      TEST_FILE,
    );
    assert.ok(vitest.text.includes(`vi.mock('./api');`), vitest.text);
  });

  it('spies on a selected object.method', async () => {
    const { text } = await run(createSpy, `import { vi } from 'vitest';\n[[console.log]];`);
    assert.ok(text.endsWith(`const logSpy = vi.spyOn(console, 'log');`), text);
  });

  it('inserts lifecycle hooks with framework naming', async () => {
    const jest = await run(createBeforeEach, `<|>`, TEST_FILE);
    assert.strictEqual(jest.text, `beforeEach(async () => {\n  \n});`);
    const pw = await run(createBeforeEach, `import { test } from '@playwright/test';\n<|>`);
    assert.ok(pw.text.includes('test.beforeEach(async () => {'), pw.text);
  });

  it('generates a sibling test file for the function at the cursor', async () => {
    const { result } = await run(
      generateTest,
      `export async function calculateTotal(price: number, quantity: number): Promise<number> {\n  return price * qua<|>ntity;\n}\nexport function other() {}`,
      { fileName: '/p/src/utils/math.ts', project: { testFramework: 'vitest' } },
    );
    assert.strictEqual(result.newFile?.path, '/p/src/utils/math.test.ts');
    assert.ok(
      result.newFile?.content.includes(
        `import { describe, it, expect } from 'vitest';\nimport { calculateTotal } from './math';`,
      ),
      result.newFile?.content,
    );
    assert.ok(
      result.newFile?.content.includes(
        `describe('calculateTotal', () => {\n  it('calculateTotal returns the expected result', async () => {\n    const result = await calculateTotal(9.99, 3);\n    expect(result).toBe(0);\n  });\n});`,
      ),
      result.newFile?.content,
    );
  });

  it('uses .spec for mocha and covers all exported functions', async () => {
    const { result } = await run(
      generateTest,
      `export function a(x: string) { return x; }\nexport function b() {}\n<|>`,
      { fileName: '/p/src/m.ts', project: { testFramework: 'mocha' } },
    );
    assert.strictEqual(result.newFile?.path, '/p/src/m.spec.ts');
    assert.ok(result.newFile?.content.includes(`import { expect } from 'chai';`), result.newFile?.content);
    assert.ok(
      result.newFile?.content.includes(`it('a returns the expected result'`) &&
        result.newFile?.content.includes(`it('b returns the expected result'`),
    );
  });

  it('is unavailable when there is nothing to test', () => {
    expectUnavailable(generateTest, `const a = 1;<|>`);
    expectUnavailable(createTest, `function f() {\n  <|>\n}`);
  });

  it('generates test data and mock factories from interfaces', async () => {
    const data = await run(
      generateTestData,
      `interface User {\n  id: number;\n  email: string;\n  nickname?: string;\n}<|>`,
    );
    assert.ok(
      data.text.includes(
        `const userData: User = {\n  id: 1,\n  email: 'user@example.com',\n  nickname: 'nickname',\n};`,
      ),
      data.text,
    );
    const mock = await run(
      generateMockData,
      `export interface User {\n  id: number;\n  active: boolean;\n}<|>`,
    );
    assert.ok(
      mock.text.includes(
        `export function createMockUser(overrides: Partial<User> = {}): User {\n  return {\n    id: 1,\n    active: true,\n    ...overrides,\n  };\n}`,
      ),
      mock.text,
    );
    expectUnavailable(
      generateMockData,
      `export interface User { id: number }\nexport function createMockUser() {}<|>`,
    );
  });

  it('generates sample arguments for a function', async () => {
    const { text } = await run(
      generateTestData,
      `function send(to: string, count: number, flags: string[]) {\n  <|>\n}`,
    );
    assert.ok(text.includes(`const sendArgs = {\n  to: 'to',\n  count: 3,\n  flags: [],\n};`), text);
  });
});
