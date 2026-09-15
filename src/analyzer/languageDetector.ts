import type { LanguageInfo } from '../types/context';

interface FamilyEntry {
  ts: boolean;
  jsx: boolean;
}

const JS_FAMILY: Record<string, FamilyEntry> = {
  javascript: { ts: false, jsx: false },
  javascriptreact: { ts: false, jsx: true },
  typescript: { ts: true, jsx: false },
  typescriptreact: { ts: true, jsx: true },
};

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
};

export const SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.keys(JS_FAMILY);

export function isSupportedLanguage(languageId: string): boolean {
  return languageId in JS_FAMILY;
}

/**
 * Detects the language from the VS Code language id, falling back to the file extension
 * (e.g. when a file is opened as plaintext).
 */
export function detectLanguage(languageId: string, fileName?: string): LanguageInfo {
  let id = languageId;
  let entry = JS_FAMILY[id];
  if (!entry && fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const mapped = EXTENSION_TO_LANGUAGE[ext];
    if (mapped) {
      id = mapped;
      entry = JS_FAMILY[mapped];
    }
  }
  if (!entry) {
    return { id: languageId, family: 'unknown', isTypeScript: false, isJsx: false, supported: false };
  }
  const jsxByExtension = /\.[jt]sx$/i.test(fileName ?? '');
  return {
    id,
    family: 'javascript',
    isTypeScript: entry.ts,
    isJsx: entry.jsx || jsxByExtension,
    supported: true,
  };
}
