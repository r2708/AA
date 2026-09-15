import type { BackendFramework, ProjectInfo, TestFramework } from '../types/context';

interface PackageJsonLike {
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const BACKEND_ORDER: [string, BackendFramework][] = [
  ['@nestjs/core', 'nest'],
  ['next', 'next'],
  ['fastify', 'fastify'],
  ['hono', 'hono'],
  ['koa', 'koa'],
  ['@hapi/hapi', 'hapi'],
  ['express', 'express'],
];

const TEST_ORDER: [string, TestFramework][] = [
  ['vitest', 'vitest'],
  ['jest', 'jest'],
  ['@playwright/test', 'playwright'],
  ['mocha', 'mocha'],
];

export function emptyProjectInfo(): ProjectInfo {
  return { dependencies: [], hasReact: false, isEsm: false };
}

/** Pure analysis of a package.json text. Never throws. */
export function analyzePackageJson(json: string | undefined, packageJsonDir?: string): ProjectInfo {
  const info: ProjectInfo = { ...emptyProjectInfo(), packageJsonDir };
  if (!json) {
    return info;
  }
  let parsed: PackageJsonLike;
  try {
    parsed = JSON.parse(json) as PackageJsonLike;
  } catch {
    return info;
  }
  const deps = new Set<string>([
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
    ...Object.keys(parsed.peerDependencies ?? {}),
  ]);
  info.dependencies = [...deps];
  info.isEsm = parsed.type === 'module';
  info.hasReact = deps.has('react') || deps.has('preact') || deps.has('next');
  for (const [dep, fw] of BACKEND_ORDER) {
    if (deps.has(dep)) {
      info.backendFramework = fw;
      break;
    }
  }
  for (const [dep, fw] of TEST_ORDER) {
    if (deps.has(dep)) {
      info.testFramework = fw;
      break;
    }
  }
  return info;
}
