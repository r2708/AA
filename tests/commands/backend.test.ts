import { assert, expectUnavailable, run } from '../helpers/harness';
import {
  createApiRoute,
  createController,
  createDeleteEndpoint,
  createErrorHandler,
  createGetEndpoint,
  createMiddleware,
  createPostEndpoint,
  createRepository,
  createService,
  detectFramework,
} from '../../src/commands/backend/backendCommands';
import { analyze } from '../helpers/harness';

describe('backend commands', () => {
  it('detects the framework from imports before package.json', () => {
    assert.strictEqual(
      detectFramework(
        analyze(`import Fastify from 'fastify';\n<|>`, { project: { backendFramework: 'express' } }),
      ).framework,
      'fastify',
    );
    assert.strictEqual(
      detectFramework(analyze(`<|>`, { project: { backendFramework: 'koa' } })).framework,
      'koa',
    );
    assert.strictEqual(detectFramework(analyze(`<|>`)).framework, undefined);
  });

  it('creates an Express GET endpoint on the detected router', async () => {
    const { text } = await run(
      createGetEndpoint,
      `import { Router } from 'express';\n\nconst api = Router();\n<|>\n`,
    );
    assert.ok(
      text.includes(
        `api.get('/path', async (req: Request, res: Response, next: NextFunction) => {\n  try {\n    \n    res.json({});\n  } catch (error) {\n    next(error);\n  }\n});`,
      ),
      text,
    );
    assert.ok(text.includes(`import type { NextFunction, Request, Response } from 'express';`), text);
  });

  it('creates a Fastify POST endpoint', async () => {
    const { text } = await run(
      createPostEndpoint,
      `import Fastify from 'fastify';\nconst app = Fastify();\n<|>\n`,
    );
    assert.ok(
      text.includes(`app.post('/path', async (request: FastifyRequest, reply: FastifyReply) => {`),
      text,
    );
  });

  it('creates Next.js route handlers', async () => {
    const { text } = await run(createDeleteEndpoint, `<|>`, {
      fileName: '/p/app/api/users/route.ts',
      project: { dependencies: ['next'], backendFramework: 'next' },
    });
    assert.ok(text.includes('export async function DELETE(request: Request) {'), text);
    assert.ok(text.includes(`import { NextResponse } from 'next/server';`), text);
  });

  it('asks for the framework when unknown', async () => {
    const { text, ui } = await run(createMiddleware, `<|>`, { picks: ['Koa'] });
    assert.ok(ui.asked[0].kind === 'pick');
    assert.ok(
      text.includes('export async function middleware(ctx: Context, next: Next): Promise<void> {'),
      text,
    );
  });

  it('names controllers/services/repositories after the file and entity', async () => {
    const service = await run(createService, `export interface User { id: string; name: string }\n<|>`, {
      fileName: '/p/src/user.service.ts',
      project: { backendFramework: 'express' },
    });
    assert.ok(service.text.includes('export class UserService {'), service.text);
    assert.ok(service.text.includes('async findAll(): Promise<User[]> {'), service.text);
    const repo = await run(createRepository, `export interface Order { id: string }\n<|>`, {
      fileName: '/p/src/order.repository.ts',
    });
    assert.ok(
      repo.text.includes('export class OrderRepository {') && repo.text.includes('Map<string, Order>'),
      repo.text,
    );
    const controller = await run(createController, `<|>`, {
      fileName: '/p/src/user.controller.ts',
      project: { backendFramework: 'nest' },
    });
    assert.ok(
      controller.text.includes("@Controller('users')") &&
        controller.text.includes('export class UserController {'),
      controller.text,
    );
    assert.ok(
      controller.text.includes(`import { Body, Controller, Get, Param, Post } from '@nestjs/common';`),
      controller.text,
    );
  });

  it('creates an Express error handler and route module in JavaScript', async () => {
    const eh = await run(createErrorHandler, `const express = require('express');\n<|>`, {
      languageId: 'javascript',
      project: { backendFramework: 'express' },
    });
    assert.ok(eh.text.includes('export function errorHandler(error, req, res, _next) {'), eh.text);
    const route = await run(createApiRoute, `<|>`, {
      languageId: 'javascript',
      project: { backendFramework: 'express' },
    });
    assert.ok(
      route.text.includes(`import { Router } from 'express';`) &&
        route.text.includes('const router = Router();'),
      route.text,
    );
  });

  it('is unavailable in React component files', () => {
    expectUnavailable(createGetEndpoint, `function App() { return <div />; }\n<|>`, {
      languageId: 'typescriptreact',
    });
  });
});
