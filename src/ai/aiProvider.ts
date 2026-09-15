/**
 * Optional AI provider abstraction. CodePilot's deterministic commands never depend on
 * it; a provider can be registered later (local Ollama, OpenAI, Anthropic, ...) through
 * the extension API (`exports.registerAIProvider`) or a future built-in implementation.
 */
import type { CodeContext } from '../types/context';

export interface AIRequest {
  /** Code the operation applies to (selection or enclosing declaration). */
  code: string;
  /** Optional free-form instruction from the user. */
  instruction?: string;
  context: Pick<
    CodeContext,
    'language' | 'selection' | 'scope' | 'declarations' | 'project' | 'testFramework'
  >;
}

export interface AIResponse {
  /** Replacement code (when the operation produces code). */
  code?: string;
  /** Explanation / notes shown to the user. */
  explanation?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  explainCode(request: AIRequest): Promise<AIResponse>;
  generateCode(request: AIRequest): Promise<AIResponse>;
  fixCode(request: AIRequest): Promise<AIResponse>;
  refactorCode(request: AIRequest): Promise<AIResponse>;
  optimizeCode(request: AIRequest): Promise<AIResponse>;
  generateTests(request: AIRequest): Promise<AIResponse>;
  generateDocumentation(request: AIRequest): Promise<AIResponse>;
}

export class AIProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();
  private activeId: string | undefined;

  register(provider: AIProvider): () => void {
    this.providers.set(provider.id, provider);
    if (!this.activeId) {
      this.activeId = provider.id;
    }
    return () => {
      this.providers.delete(provider.id);
      if (this.activeId === provider.id) {
        this.activeId = this.providers.keys().next().value;
      }
    };
  }

  setActive(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Unknown AI provider: ${id}`);
    }
    this.activeId = id;
  }

  get active(): AIProvider | undefined {
    return this.activeId ? this.providers.get(this.activeId) : undefined;
  }

  get all(): AIProvider[] {
    return [...this.providers.values()];
  }
}
