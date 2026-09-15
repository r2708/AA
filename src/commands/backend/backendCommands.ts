/**
 * Backend commands (Ctrl+Alt+F1 ... Ctrl+Alt+F12). Framework is detected from the
 * file's imports first, then package.json; when unknown the user picks one.
 */
import type { BackendFramework, CodeContext } from '../../types/context';
import type { CommandDefinition, CommandResult, UserInteraction } from '../../types/command';
import { defineCommand } from '../commandRegistry';
import {
  JS_LANGUAGES,
  canInsertStatement,
  insertStatementSnippet,
  insertTopLevelSnippet,
  no,
  ok,
  statementScopeReason,
} from '../helpers';
import { nameFromFileName } from '../../analyzer/naming';
import { ensureImports } from '../../transformations/importManager';
import {
  FRAMEWORK_LABELS,
  apiHandlerTemplate,
  apiRouteTemplate,
  controllerTemplate,
  detectRouterVariable,
  endpointTemplate,
  errorHandlerTemplate,
  middlewareTemplate,
  repositoryTemplate,
  serviceTemplate,
  type BackendTemplate,
  type HttpMethod,
} from '../../generators/backendGenerator';

const IMPORT_TO_FRAMEWORK: [RegExp, BackendFramework][] = [
  [/^@nestjs\//, 'nest'],
  [/^next(\/|$)/, 'next'],
  [/^fastify$/, 'fastify'],
  [/^hono(\/|$)/, 'hono'],
  [/^koa$|^@koa\//, 'koa'],
  [/^@hapi\//, 'hapi'],
  [/^express$/, 'express'],
];

/** Framework from the file imports, else from package.json. */
export function detectFramework(ctx: CodeContext): {
  framework?: BackendFramework;
  source: 'file' | 'project' | 'none';
} {
  for (const imp of ctx.declarations.imports) {
    for (const [pattern, fw] of IMPORT_TO_FRAMEWORK) {
      if (pattern.test(imp.moduleSpecifier)) {
        return { framework: fw, source: 'file' };
      }
    }
  }
  if (
    /[\\/]app[\\/].*route\.[jt]s$/.test(ctx.snapshot.fileName) &&
    ctx.project.dependencies.includes('next')
  ) {
    return { framework: 'next', source: 'file' };
  }
  if (ctx.project.backendFramework) {
    return { framework: ctx.project.backendFramework, source: 'project' };
  }
  return { source: 'none' };
}

async function resolveFramework(
  ctx: CodeContext,
  ui: UserInteraction,
): Promise<BackendFramework | undefined> {
  const detected = detectFramework(ctx);
  if (detected.framework) {
    return detected.framework;
  }
  const items = (Object.keys(FRAMEWORK_LABELS) as BackendFramework[]).map((fw) => ({
    label: FRAMEWORK_LABELS[fw],
    value: fw,
  }));
  return ui.pick(items, {
    title: 'CodePilot: which backend framework?',
    placeholder: 'No framework detected in the file or package.json',
  });
}

function backendApplicability(ctx: CodeContext, what: string, needsStatementPosition: boolean) {
  if (ctx.react.isReact && ctx.language.isJsx) {
    return no('Backend commands are not available in React component files.');
  }
  if (needsStatementPosition && !canInsertStatement(ctx)) {
    return no(statementScopeReason(ctx));
  }
  if (ctx.selection.kind !== 'none') {
    return no('Clear the selection to insert backend code.');
  }
  const detected = detectFramework(ctx);
  const label = detected.framework ? FRAMEWORK_LABELS[detected.framework] : undefined;
  const score = detected.source === 'file' ? 55 : detected.source === 'project' ? 35 : 10;
  return ok(score, label ? `${what} (${label})` : `${what} (framework will be asked)`);
}

function applyTemplate(
  ctx: CodeContext,
  template: BackendTemplate,
  topLevelPosition: 'after' | 'before' = 'after',
): CommandResult {
  const result = template.topLevel
    ? insertTopLevelSnippet(ctx, template.snippet, { position: topLevelPosition })
    : insertStatementSnippet(ctx, template.snippet);
  if (template.imports.length) {
    const resolution = ensureImports(ctx, template.imports);
    return { ...result, edits: [...(result.edits ?? []), ...resolution.edits] };
  }
  return result;
}

function entityTypeInFile(ctx: CodeContext): string | undefined {
  const iface = ctx.declarations.interfaces.find((i) => !/Props$|Options$|Config$/.test(i.name));
  return iface?.name ?? ctx.declarations.types.find((t) => t.members)?.name;
}

function resourceName(ctx: CodeContext): string {
  const base = nameFromFileName(ctx.snapshot.fileName).replace(
    /(Controller|Service|Repository|Routes?|Router|Handler|Middleware)$/i,
    '',
  );
  return base || 'Resource';
}

function endpointCommand(method: HttpMethod, key: string): CommandDefinition {
  const upper = method.toUpperCase();
  return defineCommand({
    id: `codepilot.create${upper.charAt(0)}${upper.slice(1).toLowerCase()}Endpoint`,
    title: `Create ${upper} Endpoint`,
    category: 'backend',
    description: `Inserts a ${upper} endpoint using the detected framework's router variable and request/response types.`,
    keybinding: { key },
    supportedLanguages: JS_LANGUAGES,
    canExecute: (ctx) => backendApplicability(ctx, `Insert a ${upper} endpoint`, true),
    async execute(ctx, ui) {
      const fw = await resolveFramework(ctx, ui);
      if (!fw) {
        return { cancelled: true };
      }
      const template = endpointTemplate(ctx, fw, method);
      const router = detectRouterVariable(ctx, fw);
      const result = applyTemplate(ctx, template);
      return {
        ...result,
        message: template.topLevel
          ? undefined
          : `Inserted ${upper} endpoint on ${router} (${FRAMEWORK_LABELS[fw]})`,
      };
    },
  });
}

export const createApiRoute: CommandDefinition = defineCommand({
  id: 'codepilot.createApiRoute',
  title: 'Create API Route',
  category: 'backend',
  description:
    'Scaffolds a router/route module for the detected framework (Express Router, Fastify plugin, Hono app, Next.js route handlers, ...).',
  keybinding: { key: 'ctrl+alt+f1' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => backendApplicability(ctx, 'Scaffold an API route module', false),
  async execute(ctx, ui) {
    const fw = await resolveFramework(ctx, ui);
    if (!fw) {
      return { cancelled: true };
    }
    return applyTemplate(ctx, apiRouteTemplate(ctx, fw));
  },
});

export const createController: CommandDefinition = defineCommand({
  id: 'codepilot.createController',
  title: 'Create Controller',
  category: 'backend',
  description:
    'Creates a controller class named after the file with findAll/findOne handlers for the detected framework.',
  keybinding: { key: 'ctrl+alt+f2' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => backendApplicability(ctx, `Create ${resourceName(ctx)}Controller`, false),
  async execute(ctx, ui) {
    const fw = await resolveFramework(ctx, ui);
    if (!fw) {
      return { cancelled: true };
    }
    return applyTemplate(ctx, controllerTemplate(ctx, fw, resourceName(ctx)));
  },
});

export const createService: CommandDefinition = defineCommand({
  id: 'codepilot.createService',
  title: 'Create Service',
  category: 'backend',
  description: 'Creates a service class typed with the entity interface found in the file.',
  keybinding: { key: 'ctrl+alt+f3' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) =>
    backendApplicability(
      ctx,
      `Create ${resourceName(ctx)}Service${entityTypeInFile(ctx) ? ` for ${entityTypeInFile(ctx)}` : ''}`,
      false,
    ),
  async execute(ctx, ui) {
    const detected = detectFramework(ctx);
    const fw = detected.framework ?? (await resolveFramework(ctx, ui));
    if (!fw) {
      return { cancelled: true };
    }
    return applyTemplate(ctx, serviceTemplate(ctx, fw, resourceName(ctx), entityTypeInFile(ctx)));
  },
});

export const createMiddleware: CommandDefinition = defineCommand({
  id: 'codepilot.createMiddleware',
  title: 'Create Middleware',
  category: 'backend',
  description: 'Creates a middleware function/class with the detected framework signature.',
  keybinding: { key: 'ctrl+alt+f4' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => backendApplicability(ctx, 'Create a middleware', false),
  async execute(ctx, ui) {
    const fw = await resolveFramework(ctx, ui);
    if (!fw) {
      return { cancelled: true };
    }
    return applyTemplate(ctx, middlewareTemplate(ctx, fw));
  },
});

export const createRepository: CommandDefinition = defineCommand({
  id: 'codepilot.createRepository',
  title: 'Create Repository',
  category: 'backend',
  description:
    'Creates an in-memory repository class typed with the entity interface found in the file (findAll/findById/create/delete).',
  keybinding: { key: 'ctrl+alt+f5' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) =>
    backendApplicability(
      ctx,
      `Create ${resourceName(ctx)}Repository${entityTypeInFile(ctx) ? ` for ${entityTypeInFile(ctx)}` : ''}`,
      false,
    ),
  async execute(ctx) {
    return applyTemplate(ctx, repositoryTemplate(ctx, resourceName(ctx), entityTypeInFile(ctx)));
  },
});

export const createGetEndpoint = endpointCommand('get', 'ctrl+alt+f6');
export const createPostEndpoint = endpointCommand('post', 'ctrl+alt+f7');
export const createPutEndpoint = endpointCommand('put', 'ctrl+alt+f8');
export const createPatchEndpoint = endpointCommand('patch', 'ctrl+alt+f9');
export const createDeleteEndpoint = endpointCommand('delete', 'ctrl+alt+f10');

export const createApiHandler: CommandDefinition = defineCommand({
  id: 'codepilot.createApiHandler',
  title: 'Create API Handler',
  category: 'backend',
  description:
    'Creates a framework-agnostic fetch-style handler (or a Next.js pages API handler) with error handling.',
  keybinding: { key: 'ctrl+alt+f11' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => backendApplicability(ctx, 'Create an API handler', false),
  async execute(ctx) {
    const fw = detectFramework(ctx).framework ?? 'express';
    return applyTemplate(ctx, apiHandlerTemplate(ctx, fw));
  },
});

export const createErrorHandler: CommandDefinition = defineCommand({
  id: 'codepilot.createErrorHandler',
  title: 'Create Error Handler',
  category: 'backend',
  description:
    'Creates the framework-specific error handler (Express 4-arg middleware, Fastify setErrorHandler, Nest exception filter, ...).',
  keybinding: { key: 'ctrl+alt+f12' },
  supportedLanguages: JS_LANGUAGES,
  canExecute: (ctx) => backendApplicability(ctx, 'Create an error handler', false),
  async execute(ctx, ui) {
    const fw = await resolveFramework(ctx, ui);
    if (!fw) {
      return { cancelled: true };
    }
    return applyTemplate(ctx, errorHandlerTemplate(ctx, fw));
  },
});

export const backendCommands: CommandDefinition[] = [
  createApiRoute,
  createController,
  createService,
  createMiddleware,
  createRepository,
  createGetEndpoint,
  createPostEndpoint,
  createPutEndpoint,
  createPatchEndpoint,
  createDeleteEndpoint,
  createApiHandler,
  createErrorHandler,
];
