import type { CodeContext, DocumentSnapshot, LanguageInfo } from '../types/context';

/**
 * A language adapter turns a raw document snapshot into a fully analysed CodeContext.
 * The TypeScript adapter is the first implementation; adapters for other languages
 * register themselves with the LanguageRegistry and provide their own `ast` payload.
 */
export interface LanguageAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly languageIds: readonly string[];
  analyze(snapshot: DocumentSnapshot, language: LanguageInfo): CodeContext;
}

export class LanguageRegistry {
  private readonly adapters = new Map<string, LanguageAdapter>();

  register(adapter: LanguageAdapter): void {
    for (const id of adapter.languageIds) {
      this.adapters.set(id, adapter);
    }
  }

  forLanguage(languageId: string): LanguageAdapter | undefined {
    return this.adapters.get(languageId);
  }

  get supportedLanguageIds(): string[] {
    return [...this.adapters.keys()];
  }
}
