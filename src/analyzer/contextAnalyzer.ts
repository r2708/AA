import type { CodeContext, DocumentSnapshot } from '../types/context';
import { CodePilotError } from '../types/command';
import { detectLanguage } from './languageDetector';
import { LanguageRegistry } from '../languages/languageAdapter';
import { TypeScriptAdapter } from '../languages/typescript/typescriptAdapter';

/**
 * Entry point of the analysis pipeline:
 *   snapshot → language detection → language adapter → CodeContext
 */
export class ContextAnalyzer {
  readonly languages: LanguageRegistry;

  constructor(registry?: LanguageRegistry) {
    this.languages = registry ?? new LanguageRegistry();
    if (!registry) {
      this.languages.register(new TypeScriptAdapter());
    }
  }

  analyze(snapshot: DocumentSnapshot): CodeContext {
    const language = detectLanguage(snapshot.languageId, snapshot.fileName);
    if (!language.supported) {
      throw new CodePilotError(
        'unsupportedLanguage',
        `CodePilot does not support "${snapshot.languageId}" files yet. Supported: JavaScript, TypeScript, JSX and TSX.`,
      );
    }
    const adapter = this.languages.forLanguage(language.id);
    if (!adapter) {
      throw new CodePilotError('unsupportedLanguage', `No language adapter registered for "${language.id}".`);
    }
    try {
      return adapter.analyze(snapshot, language);
    } catch (error) {
      if (error instanceof CodePilotError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CodePilotError('parseError', `CodePilot could not analyze this file: ${message}`);
    }
  }
}

let defaultAnalyzer: ContextAnalyzer | undefined;

export function getDefaultAnalyzer(): ContextAnalyzer {
  if (!defaultAnalyzer) {
    defaultAnalyzer = new ContextAnalyzer();
  }
  return defaultAnalyzer;
}
