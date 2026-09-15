/**
 * Framework-aware backend templates (Express, Fastify, Koa, Hono, Next.js, NestJS).
 * Templates are snippet bodies using `\t`/`\n` and VS Code placeholders.
 */
import type { BackendFramework, CodeContext } from '../types/context';
import type { ImportRequest } from '../transformations/importManager';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface BackendTemplate {
  snippet: string;
  imports: ImportRequest[];
  /** Whether the snippet is a top-level declaration (vs. a statement). */
  topLevel: boolean;
}

export const FRAMEWORK_LABELS: Record<BackendFramework, string> = {
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  hono: 'Hono',
  next: 'Next.js (App Router)',
  nest: 'NestJS',
  hapi: 'hapi',
};

function ts(ctx: CodeContext, text: string): string {
  return ctx.language.isTypeScript ? text : '';
}

/** Name of the router/app variable declared in the file, if any. */
export function detectRouterVariable(ctx: CodeContext, fw: BackendFramework): string {
  const candidates = ctx.declarations.variables.filter((v) => v.initializerText);
  const byInit = (pattern: RegExp) => candidates.find((v) => pattern.test(v.initializerText ?? ''))?.name;
  switch (fw) {
    case 'express':
      return byInit(/Router\(\)/) ?? byInit(/express\(\)/) ?? 'router';
    case 'fastify':
      return byInit(/[fF]astify\(/) ?? 'fastify';
    case 'koa':
      return byInit(/new Router\(/) ?? byInit(/new Koa\(/) ?? 'router';
    case 'hono':
      return byInit(/new Hono\(/) ?? 'app';
    case 'hapi':
      return byInit(/[Ss]erver\(/) ?? 'server';
    default:
      return 'app';
  }
}

export function endpointTemplate(
  ctx: CodeContext,
  fw: BackendFramework,
  method: HttpMethod,
): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const q = ctx.style.quote;
  const router = detectRouterVariable(ctx, fw);
  const upper = method.toUpperCase();
  const isTs = ctx.language.isTypeScript;
  switch (fw) {
    case 'fastify':
      return {
        topLevel: false,
        imports: isTs
          ? [{ module: 'fastify', named: ['FastifyReply', 'FastifyRequest'], typeOnly: true }]
          : [],
        snippet: `${router}.${method}(${q}/\${1:path}${q}, async (request${ts(ctx, ': FastifyRequest')}, reply${ts(ctx, ': FastifyReply')}) => {\n\t$0\n\treturn reply.send({})${semi}\n})${semi}`,
      };
    case 'koa':
      return {
        topLevel: false,
        imports: isTs ? [{ module: 'koa', named: ['Context'], typeOnly: true }] : [],
        snippet: `${router}.${method}(${q}/\${1:path}${q}, async (ctx${ts(ctx, ': Context')}) => {\n\t$0\n\tctx.body = {}${semi}\n})${semi}`,
      };
    case 'hono':
      return {
        topLevel: false,
        imports: [],
        snippet: `${router}.${method}(${q}/\${1:path}${q}, async (c) => {\n\t$0\n\treturn c.json({})${semi}\n})${semi}`,
      };
    case 'next':
      return {
        topLevel: true,
        imports: isTs
          ? [{ module: 'next/server', named: ['NextResponse'] }]
          : [{ module: 'next/server', named: ['NextResponse'] }],
        snippet: `export async function ${upper}(request${ts(ctx, ': Request')}) {\n\t$0\n\treturn NextResponse.json({})${semi}\n}`,
      };
    case 'nest': {
      const decorator = upper.charAt(0) + upper.slice(1).toLowerCase();
      return {
        topLevel: false,
        imports: [{ module: '@nestjs/common', named: [decorator] }],
        snippet: `@${decorator}(${q}\${1:path}${q})\nasync \${2:handler}()${ts(ctx, ': Promise<\\${3:unknown}>')} {\n\t$0\n}`,
      };
    }
    case 'hapi':
      return {
        topLevel: false,
        imports: [],
        snippet: `${router}.route({\n\tmethod: ${q}${upper}${q},\n\tpath: ${q}/\${1:path}${q},\n\thandler: async (request, h) => {\n\t\t$0\n\t\treturn h.response({})${semi}\n\t},\n})${semi}`,
      };
    case 'express':
    default:
      return {
        topLevel: false,
        imports: isTs
          ? [{ module: 'express', named: ['NextFunction', 'Request', 'Response'], typeOnly: true }]
          : [],
        snippet: `${router}.${method}(${q}/\${1:path}${q}, async (req${ts(ctx, ': Request')}, res${ts(ctx, ': Response')}, next${ts(ctx, ': NextFunction')}) => {\n\ttry {\n\t\t$0\n\t\tres.json({})${semi}\n\t} catch (error) {\n\t\tnext(error)${semi}\n\t}\n})${semi}`,
      };
  }
}

export function middlewareTemplate(ctx: CodeContext, fw: BackendFramework): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const isTs = ctx.language.isTypeScript;
  switch (fw) {
    case 'fastify':
      return {
        topLevel: true,
        imports: isTs
          ? [{ module: 'fastify', named: ['FastifyReply', 'FastifyRequest'], typeOnly: true }]
          : [],
        snippet: `export async function \${1:middleware}(request${ts(ctx, ': FastifyRequest')}, reply${ts(ctx, ': FastifyReply')})${ts(ctx, ': Promise<void>')} {\n\t$0\n}`,
      };
    case 'koa':
      return {
        topLevel: true,
        imports: isTs ? [{ module: 'koa', named: ['Context', 'Next'], typeOnly: true }] : [],
        snippet: `export async function \${1:middleware}(ctx${ts(ctx, ': Context')}, next${ts(ctx, ': Next')})${ts(ctx, ': Promise<void>')} {\n\t$0\n\tawait next()${semi}\n}`,
      };
    case 'hono':
      return {
        topLevel: true,
        imports: isTs ? [{ module: 'hono', named: ['MiddlewareHandler'], typeOnly: true }] : [],
        snippet: `export const \${1:middleware}${ts(ctx, ': MiddlewareHandler')} = async (c, next) => {\n\t$0\n\tawait next()${semi}\n}${semi}`,
      };
    case 'next':
      return {
        topLevel: true,
        imports: [
          { module: 'next/server', named: ['NextResponse'] },
          ...(isTs ? [{ module: 'next/server', named: ['NextRequest'], typeOnly: true }] : []),
        ],
        snippet: `export function middleware(request${ts(ctx, ': NextRequest')}) {\n\t$0\n\treturn NextResponse.next()${semi}\n}`,
      };
    case 'nest':
      return {
        topLevel: true,
        imports: [
          { module: '@nestjs/common', named: ['Injectable', 'NestMiddleware'] },
          ...(isTs
            ? [{ module: 'express', named: ['NextFunction', 'Request', 'Response'], typeOnly: true }]
            : []),
        ],
        snippet: `@Injectable()\nexport class \${1:Name}Middleware implements NestMiddleware {\n\tuse(req${ts(ctx, ': Request')}, res${ts(ctx, ': Response')}, next${ts(ctx, ': NextFunction')}) {\n\t\t$0\n\t\tnext()${semi}\n\t}\n}`,
      };
    case 'hapi':
      return {
        topLevel: true,
        imports: [],
        snippet: `export const \${1:plugin} = {\n\tname: '\${1}',\n\tregister: async (server) => {\n\t\tserver.ext(${ctx.style.quote}onRequest${ctx.style.quote}, async (request, h) => {\n\t\t\t$0\n\t\t\treturn h.continue${semi}\n\t\t})${semi}\n\t},\n}${semi}`,
      };
    case 'express':
    default:
      return {
        topLevel: true,
        imports: isTs
          ? [{ module: 'express', named: ['NextFunction', 'Request', 'Response'], typeOnly: true }]
          : [],
        snippet: `export function \${1:middleware}(req${ts(ctx, ': Request')}, res${ts(ctx, ': Response')}, next${ts(ctx, ': NextFunction')})${ts(ctx, ': void')} {\n\t$0\n\tnext()${semi}\n}`,
      };
  }
}

export function errorHandlerTemplate(ctx: CodeContext, fw: BackendFramework): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const q = ctx.style.quote;
  const isTs = ctx.language.isTypeScript;
  switch (fw) {
    case 'fastify':
      return {
        topLevel: false,
        imports: [],
        snippet: `${detectRouterVariable(ctx, fw)}.setErrorHandler((error, request, reply) => {\n\trequest.log.error(error)${semi}\n\t$0\n\treply.status(\${1:500}).send({ message: error.message })${semi}\n})${semi}`,
      };
    case 'koa':
      return {
        topLevel: true,
        imports: isTs ? [{ module: 'koa', named: ['Context', 'Next'], typeOnly: true }] : [],
        snippet: `export async function errorHandler(ctx${ts(ctx, ': Context')}, next${ts(ctx, ': Next')})${ts(ctx, ': Promise<void>')} {\n\ttry {\n\t\tawait next()${semi}\n\t} catch (error) {\n\t\t$0\n\t\tctx.status = \${1:500}${semi}\n\t\tctx.body = { message: error instanceof Error ? error.message : ${q}Internal Server Error${q} }${semi}\n\t}\n}`,
      };
    case 'hono':
      return {
        topLevel: false,
        imports: [],
        snippet: `${detectRouterVariable(ctx, fw)}.onError((error, c) => {\n\tconsole.error(error)${semi}\n\t$0\n\treturn c.json({ message: error.message }, \${1:500})${semi}\n})${semi}`,
      };
    case 'nest':
      return {
        topLevel: true,
        imports: [
          { module: '@nestjs/common', named: ['ArgumentsHost', 'Catch', 'ExceptionFilter', 'HttpException'] },
        ],
        snippet: `@Catch(HttpException)\nexport class \${1:Http}ExceptionFilter implements ExceptionFilter {\n\tcatch(exception${ts(ctx, ': HttpException')}, host${ts(ctx, ': ArgumentsHost')}) {\n\t\tconst response = host.switchToHttp().getResponse()${semi}\n\t\t$0\n\t\tresponse.status(exception.getStatus()).json({ message: exception.message })${semi}\n\t}\n}`,
      };
    case 'next':
      return {
        topLevel: true,
        imports: [],
        snippet: `${q}use client${q}${semi}\n\nexport default function Error({ error, reset }${ts(ctx, ': { error: Error; reset: () => void }')}) {\n\treturn (\n\t\t<div>\n\t\t\t<h2>\${1:Something went wrong}</h2>\n\t\t\t<button onClick={reset}>Try again</button>\n\t\t</div>\n\t)${semi}\n}`,
      };
    case 'hapi':
      return {
        topLevel: false,
        imports: [],
        snippet: `${detectRouterVariable(ctx, fw)}.ext(${q}onPreResponse${q}, (request, h) => {\n\tconst response = request.response${semi}\n\tif (response instanceof Error) {\n\t\t$0\n\t\treturn h.response({ message: response.message }).code(\${1:500})${semi}\n\t}\n\treturn h.continue${semi}\n})${semi}`,
      };
    case 'express':
    default:
      return {
        topLevel: true,
        imports: isTs
          ? [{ module: 'express', named: ['NextFunction', 'Request', 'Response'], typeOnly: true }]
          : [],
        snippet: `export function errorHandler(error${ts(ctx, ': unknown')}, req${ts(ctx, ': Request')}, res${ts(ctx, ': Response')}, _next${ts(ctx, ': NextFunction')})${ts(ctx, ': void')} {\n\tconsole.error(error)${semi}\n\t$0\n\tres.status(\${1:500}).json({ message: error instanceof Error ? error.message : ${q}Internal Server Error${q} })${semi}\n}`,
      };
  }
}

export function apiRouteTemplate(ctx: CodeContext, fw: BackendFramework): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const q = ctx.style.quote;
  const isTs = ctx.language.isTypeScript;
  switch (fw) {
    case 'fastify':
      return {
        topLevel: true,
        imports: isTs ? [{ module: 'fastify', named: ['FastifyInstance'], typeOnly: true }] : [],
        snippet: `export async function \${1:routes}(fastify${ts(ctx, ': FastifyInstance')}) {\n\tfastify.get(${q}/\${2:path}${q}, async () => {\n\t\t$0\n\t\treturn {}${semi}\n\t})${semi}\n}`,
      };
    case 'koa':
      return {
        topLevel: true,
        imports: [{ module: '@koa/router', defaultName: 'Router' }],
        snippet: `const \${1:router} = new Router({ prefix: ${q}/\${2:path}${q} })${semi}\n\n\${1}.get(${q}/${q}, async (ctx) => {\n\t$0\n\tctx.body = {}${semi}\n})${semi}\n\nexport default \${1}${semi}`,
      };
    case 'hono':
      return {
        topLevel: true,
        imports: [{ module: 'hono', named: ['Hono'] }],
        snippet: `const \${1:app} = new Hono()${semi}\n\n\${1}.get(${q}/\${2:path}${q}, (c) => {\n\t$0\n\treturn c.json({})${semi}\n})${semi}\n\nexport default \${1}${semi}`,
      };
    case 'next':
      return {
        topLevel: true,
        imports: [{ module: 'next/server', named: ['NextResponse'] }],
        snippet: `export async function GET(request${ts(ctx, ': Request')}) {\n\t$0\n\treturn NextResponse.json({})${semi}\n}\n\nexport async function POST(request${ts(ctx, ': Request')}) {\n\tconst body = await request.json()${semi}\n\treturn NextResponse.json(body, { status: 201 })${semi}\n}`,
      };
    case 'nest':
      return controllerTemplate(ctx, fw);
    case 'hapi':
      return {
        topLevel: true,
        imports: isTs ? [{ module: '@hapi/hapi', named: ['ServerRoute'], typeOnly: true }] : [],
        snippet: `export const \${1:routes}${ts(ctx, ': ServerRoute[]')} = [\n\t{\n\t\tmethod: ${q}GET${q},\n\t\tpath: ${q}/\${2:path}${q},\n\t\thandler: async (request, h) => {\n\t\t\t$0\n\t\t\treturn h.response({})${semi}\n\t\t},\n\t},\n]${semi}`,
      };
    case 'express':
    default:
      return {
        topLevel: true,
        imports: [{ module: 'express', named: ['Router'] }],
        snippet: `const \${1:router} = Router()${semi}\n\n\${1}.get(${q}/\${2:path}${q}, async (req, res, next) => {\n\ttry {\n\t\t$0\n\t\tres.json({})${semi}\n\t} catch (error) {\n\t\tnext(error)${semi}\n\t}\n})${semi}\n\nexport default \${1}${semi}`,
      };
  }
}

export function controllerTemplate(
  ctx: CodeContext,
  fw: BackendFramework,
  name = 'Resource',
): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const q = ctx.style.quote;
  const isTs = ctx.language.isTypeScript;
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  if (fw === 'nest') {
    return {
      topLevel: true,
      imports: [{ module: '@nestjs/common', named: ['Body', 'Controller', 'Get', 'Param', 'Post'] }],
      snippet: `@Controller(${q}\${1:${lower}s}${q})\nexport class \${2:${name}}Controller {\n\tconstructor(private readonly \${3:${lower}Service}: \${2}Service) {}\n\n\t@Get()\n\tfindAll() {\n\t\treturn this.\${3}.findAll()${semi}\n\t}\n\n\t@Get(${q}:id${q})\n\tfindOne(@Param(${q}id${q}) id${ts(ctx, ': string')}) {\n\t\treturn this.\${3}.findOne(id)${semi}\n\t}\n\n\t@Post()\n\tcreate(@Body() body${ts(ctx, ': unknown')}) {\n\t\treturn this.\${3}.create(body)${semi}\n\t}\n}`,
    };
  }
  const reqType = fw === 'fastify' ? 'FastifyRequest' : fw === 'koa' ? 'Context' : 'Request';
  const resType = fw === 'fastify' ? 'FastifyReply' : fw === 'koa' ? '' : 'Response';
  const imports: ImportRequest[] = [];
  if (isTs) {
    if (fw === 'fastify') {
      imports.push({ module: 'fastify', named: ['FastifyReply', 'FastifyRequest'], typeOnly: true });
    } else if (fw === 'koa') {
      imports.push({ module: 'koa', named: ['Context'], typeOnly: true });
    } else if (fw === 'express') {
      imports.push({ module: 'express', named: ['Request', 'Response'], typeOnly: true });
    }
  }
  const params =
    fw === 'koa'
      ? `ctx${ts(ctx, `: ${reqType}`)}`
      : `req${ts(ctx, `: ${reqType}`)}, res${ts(ctx, `: ${resType}`)}`;
  const respond = fw === 'koa' ? 'ctx.body = ' : fw === 'fastify' ? 'return res.send(' : 'res.json(';
  const close = fw === 'koa' ? '' : ')';
  return {
    topLevel: true,
    imports,
    snippet: `export class \${1:${name}}Controller {\n\tconstructor(private readonly \${2:${lower}Service}${ts(ctx, `: \\${1}Service`)}) {}\n\n\tasync findAll(${params}) {\n\t\tconst items = await this.\${2}.findAll()${semi}\n\t\t${respond}items${close}${semi}\n\t}\n\n\tasync findOne(${params}) {\n\t\tconst item = await this.\${2}.findOne(${fw === 'koa' ? 'ctx.params.id' : fw === 'fastify' ? '(req.params as { id: string }).id' : 'req.params.id'})${semi}\n\t\t$0\n\t\t${respond}item${close}${semi}\n\t}\n}`,
  };
}

export function serviceTemplate(
  ctx: CodeContext,
  fw: BackendFramework,
  name = 'Resource',
  entityType?: string,
): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const entity = entityType ?? `\${1:${name}}`;
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  const decorator = fw === 'nest' ? '@Injectable()\n' : '';
  const imports: ImportRequest[] = fw === 'nest' ? [{ module: '@nestjs/common', named: ['Injectable'] }] : [];
  return {
    topLevel: true,
    imports,
    snippet: `${decorator}export class \${1:${name}}Service {\n\tconstructor(private readonly \${2:${lower}Repository}${ts(ctx, `: \\${1}Repository`)}) {}\n\n\tasync findAll()${ts(ctx, `: Promise<${entity}[]>`)} {\n\t\treturn this.\${2}.findAll()${semi}\n\t}\n\n\tasync findOne(id${ts(ctx, ': string')})${ts(ctx, `: Promise<${entity} | undefined>`)} {\n\t\treturn this.\${2}.findById(id)${semi}\n\t}\n\n\tasync create(data${ts(ctx, `: Omit<${entity}, 'id'>`)})${ts(ctx, `: Promise<${entity}>`)} {\n\t\t$0\n\t\treturn this.\${2}.create(data)${semi}\n\t}\n}`,
  };
}

export function repositoryTemplate(
  ctx: CodeContext,
  name = 'Resource',
  entityType?: string,
): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const isTs = ctx.language.isTypeScript;
  const entity = entityType ?? `\${1:${name}}`;
  const generic = isTs ? `<${entity}>` : '';
  return {
    topLevel: true,
    imports: [],
    snippet: `export class \${1:${name}}Repository {\n\tprivate readonly items = new Map${generic ? `<string, ${entity}>` : ''}()${semi}\n\n\tasync findAll()${ts(ctx, `: Promise<${entity}[]>`)} {\n\t\treturn [...this.items.values()]${semi}\n\t}\n\n\tasync findById(id${ts(ctx, ': string')})${ts(ctx, `: Promise<${entity} | undefined>`)} {\n\t\treturn this.items.get(id)${semi}\n\t}\n\n\tasync create(data${ts(ctx, `: Omit<${entity}, 'id'>`)})${ts(ctx, `: Promise<${entity}>`)} {\n\t\tconst item = { ...data, id: crypto.randomUUID() }${ts(ctx, ` as ${entity}`)}${semi}\n\t\tthis.items.set(item.id, item)${semi}\n\t\treturn item${semi}\n\t}\n\n\tasync delete(id${ts(ctx, ': string')})${ts(ctx, ': Promise<boolean>')} {\n\t\treturn this.items.delete(id)${semi}\n\t}\n}`,
  };
}

export function apiHandlerTemplate(ctx: CodeContext, fw: BackendFramework): BackendTemplate {
  const semi = ctx.style.semicolons ? ';' : '';
  const isTs = ctx.language.isTypeScript;
  if (fw === 'next') {
    return {
      topLevel: true,
      imports: isTs ? [{ module: 'next', named: ['NextApiRequest', 'NextApiResponse'], typeOnly: true }] : [],
      snippet: `export default async function handler(req${ts(ctx, ': NextApiRequest')}, res${ts(ctx, ': NextApiResponse')}) {\n\tif (req.method !== ${ctx.style.quote}\${1:GET}${ctx.style.quote}) {\n\t\treturn res.status(405).end()${semi}\n\t}\n\t$0\n\tres.status(200).json({})${semi}\n}`,
    };
  }
  return {
    topLevel: true,
    imports: [],
    snippet: `export async function \${1:handler}(request${ts(ctx, ': Request')})${ts(ctx, ': Promise<Response>')} {\n\ttry {\n\t\t$0\n\t\treturn Response.json({})${semi}\n\t} catch (error) {\n\t\treturn Response.json({ message: error instanceof Error ? error.message : ${ctx.style.quote}Internal Server Error${ctx.style.quote} }, { status: 500 })${semi}\n\t}\n}`,
  };
}
