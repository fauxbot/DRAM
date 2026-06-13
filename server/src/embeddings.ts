export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly name: string;
}

export class OllamaEmbedding implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private baseUrl: string;
  private model: string;

  constructor(opts?: { baseUrl?: string; model?: string; dimensions?: number }) {
    this.baseUrl = opts?.baseUrl || "http://localhost:11434";
    this.model = opts?.model || "nomic-embed-text";
    this.dimensions = opts?.dimensions || 768;
    this.name = `ollama/${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) {
        throw new Error(`Ollama embedding failed: ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      results.push(data.embeddings[0]);
    }
    return results;
  }
}

export class NoopEmbedding implements EmbeddingProvider {
  readonly dimensions = 0;
  readonly name = "none";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export async function detectProvider(): Promise<EmbeddingProvider> {
  const provider = process.env.DRAM_EMBEDDING_PROVIDER || "ollama";
  const ollamaUrl = process.env.DRAM_OLLAMA_URL || "http://localhost:11434";
  const ollamaModel = process.env.DRAM_EMBEDDING_MODEL || "nomic-embed-text";

  if (provider === "none") {
    return new NoopEmbedding();
  }

  if (provider === "ollama") {
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const ollama = new OllamaEmbedding({
          baseUrl: ollamaUrl,
          model: ollamaModel,
        });
        // Probe dimensions with a test embed
        try {
          const test = await ollama.embed(["test"]);
          if (test[0].length > 0) {
            const detected = new OllamaEmbedding({
              baseUrl: ollamaUrl,
              model: ollamaModel,
              dimensions: test[0].length,
            });
            process.stderr.write(
              `dram: using ${detected.name} (${detected.dimensions}d)\n`
            );
            return detected;
          }
        } catch {
          // model not pulled — fall through
        }
      }
    } catch {
      // Ollama not running — fall through
    }
  }

  process.stderr.write(
    "dram: no embedding provider available, using keyword search only\n"
  );
  return new NoopEmbedding();
}
