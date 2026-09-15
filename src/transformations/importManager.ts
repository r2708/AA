/**
 * Import intelligence: reuse existing imports, merge named imports into an
 * existing declaration from the same module, otherwise add a new import.
 */
import * as ts from 'typescript';
import type { CodeContext } from '../types/context';
import type { TextEdit } from '../types/command';
import { tsOf } from '../languages/typescript/tsContext';
import { planImportInsertion } from './insertion';
import { quote, semi } from '../generators/codeWriter';

export interface ImportRequest {
  module: string;
  named?: string[];
  defaultName?: string;
  typeOnly?: boolean;
}

export interface ImportResolution {
  edits: TextEdit[];
  /** Local identifier to use for each requested name (handles aliases / namespace imports). */
  localNames: Map<string, string>;
  /** Names that were already imported. */
  reused: string[];
  /** Names newly added. */
  added: string[];
}

function findImportDeclarations(ctx: CodeContext, module: string): ts.ImportDeclaration[] {
  const sf = tsOf(ctx).sourceFile;
  return sf.statements.filter(
    (s): s is ts.ImportDeclaration =>
      ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === module,
  );
}

function buildImportStatement(ctx: CodeContext, req: ImportRequest, named: string[]): string {
  const parts: string[] = [];
  if (req.defaultName) {
    parts.push(req.defaultName);
  }
  if (named.length) {
    parts.push(`{ ${named.join(', ')} }`);
  }
  const typePrefix = req.typeOnly ? 'type ' : '';
  return `import ${typePrefix}${parts.join(', ')} from ${quote(ctx, req.module)}${semi(ctx)}`;
}

/**
 * Ensures the requested bindings are imported. Never duplicates an existing import.
 * Returned edits are safe to combine with edits elsewhere in the document.
 */
export function ensureImports(ctx: CodeContext, requests: ImportRequest[]): ImportResolution {
  const sf = tsOf(ctx).sourceFile;
  const edits: TextEdit[] = [];
  const localNames = new Map<string, string>();
  const reused: string[] = [];
  const added: string[] = [];
  const newStatements: string[] = [];

  for (const req of requests) {
    const wanted = [...new Set(req.named ?? [])];
    const existing = findImportDeclarations(ctx, req.module);
    const missing: string[] = [];
    let needDefault = !!req.defaultName;

    // Pass 1: what is already available?
    for (const name of wanted) {
      let found = false;
      for (const decl of existing) {
        const clause = decl.importClause;
        if (!clause) {
          continue;
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const spec = clause.namedBindings.elements.find((e) => (e.propertyName ?? e.name).text === name);
          if (spec) {
            localNames.set(name, spec.name.text);
            found = true;
            break;
          }
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          localNames.set(name, `${clause.namedBindings.name.text}.${name}`);
          found = true;
          break;
        }
      }
      if (found) {
        reused.push(name);
      } else {
        missing.push(name);
      }
    }
    if (needDefault) {
      for (const decl of existing) {
        if (decl.importClause?.name) {
          localNames.set(req.defaultName as string, decl.importClause.name.text);
          reused.push(req.defaultName as string);
          needDefault = false;
          break;
        }
      }
    }
    if (missing.length === 0 && !needDefault) {
      continue;
    }

    // Pass 2: merge into an existing value import from the same module when safe.
    const mergeTarget = existing.find(
      (d) =>
        d.importClause &&
        !d.importClause.isTypeOnly &&
        !(d.importClause.namedBindings && ts.isNamespaceImport(d.importClause.namedBindings)),
    );
    if (mergeTarget && !req.typeOnly) {
      const clause = mergeTarget.importClause as ts.ImportClause;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const bindings = clause.namedBindings;
        const bindingText = bindings.getText(sf);
        const spaced = /^\{\s/.test(bindingText);
        const multiLine = bindingText.includes('\n');
        if (missing.length) {
          if (bindings.elements.length === 0) {
            edits.push({
              range: { start: bindings.getStart(sf), end: bindings.getEnd() },
              text: `{ ${missing.join(', ')} }`,
            });
          } else {
            const lastEl = bindings.elements[bindings.elements.length - 1];
            let insertAt = lastEl.getEnd();
            const trailing = /^\s*,/.exec(ctx.text.slice(insertAt, bindings.getEnd()));
            const hasTrailingComma = !!trailing;
            if (hasTrailingComma) {
              insertAt += (trailing as RegExpExecArray)[0].length;
            }
            if (multiLine) {
              const elIndent =
                /^[ \t]*/.exec(ctx.text.slice(ctx.text.lastIndexOf('\n', lastEl.getStart(sf)) + 1))?.[0] ??
                ctx.indent.unit;
              const text = hasTrailingComma
                ? missing.map((m) => `${ctx.eol}${elIndent}${m},`).join('')
                : `,` + missing.map((m) => `${ctx.eol}${elIndent}${m}`).join(',');
              edits.push({ range: { start: insertAt, end: insertAt }, text });
            } else {
              const text = hasTrailingComma ? ` ${missing.join(', ')},` : `, ${missing.join(', ')}`;
              edits.push({ range: { start: insertAt, end: insertAt }, text });
            }
          }
          void spaced;
          missing.forEach((m) => {
            localNames.set(m, m);
            added.push(m);
          });
        }
        if (needDefault && !clause.name) {
          const start = clause.getStart(sf);
          edits.push({ range: { start, end: start }, text: `${req.defaultName}, ` });
          localNames.set(req.defaultName as string, req.defaultName as string);
          added.push(req.defaultName as string);
          needDefault = false;
        }
        continue;
      }
      if (clause.name && !clause.namedBindings && missing.length) {
        // `import React from 'react'` → `import React, { useState } from 'react'`
        const end = clause.name.getEnd();
        edits.push({ range: { start: end, end }, text: `, { ${missing.join(', ')} }` });
        missing.forEach((m) => {
          localNames.set(m, m);
          added.push(m);
        });
        continue;
      }
    }

    // Pass 3: brand new import declaration.
    const statement = buildImportStatement(
      ctx,
      { ...req, defaultName: needDefault ? req.defaultName : undefined },
      missing,
    );
    newStatements.push(statement);
    missing.forEach((m) => {
      localNames.set(m, m);
      added.push(m);
    });
    if (needDefault) {
      localNames.set(req.defaultName as string, req.defaultName as string);
      added.push(req.defaultName as string);
    }
  }

  if (newStatements.length) {
    const plan = planImportInsertion(ctx);
    edits.push({ range: plan.range, text: plan.prefix + newStatements.join(ctx.eol) + plan.suffix });
  }
  return { edits, localNames, reused, added };
}

/** True when `name` is already bound by an import (any module). */
export function isImported(ctx: CodeContext, name: string): boolean {
  return ctx.declarations.imports.some(
    (i) =>
      i.defaultImport === name ||
      i.namespaceImport === name ||
      i.namedImports.some((n) => (n.alias ?? n.name) === name),
  );
}

/** Existing import declaration (if any) for the module. */
export function getImportFor(ctx: CodeContext, module: string) {
  return ctx.declarations.imports.find((i) => i.moduleSpecifier === module);
}
