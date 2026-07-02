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
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(
        `Ollama embedding failed: ${res.status} ${res.statusText}`
      );
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    dimensions?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (
      opts.baseUrl || "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    this.model = opts.model || "text-embedding-3-small";
    this.dimensions = opts.dimensions || 1536;
    this.name = `openai/${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OpenAI embedding failed (${res.status}): ${body}`
      );
    }
    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
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
  const model = process.env.DRAM_EMBEDDING_MODEL;

  if (provider === "none") {
    return new NoopEmbedding();
  }

  if (provider === "openai") {
    const apiKey =
      process.env.DRAM_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!apiKey) {
      process.stderr.write(
        "dram: DRAM_EMBEDDING_PROVIDER=openai but no API key found (set DRAM_OPENAI_API_KEY or OPENAI_API_KEY)\n"
      );
      return new NoopEmbedding();
    }

    const baseUrl = process.env.DRAM_EMBEDDING_URL;
    const openai = new OpenAIEmbedding({
      apiKey,
      baseUrl,
      model: model || "text-embedding-3-small",
    });

    try {
      const test = await openai.embed(["test"]);
      if (test[0] && test[0].length > 0) {
        const detected = new OpenAIEmbedding({
          apiKey,
          baseUrl,
          model: model || "text-embedding-3-small",
          dimensions: test[0].length,
        });
        process.stderr.write(
          `dram: using ${detected.name} (${detected.dimensions}d)\n`
        );
        return detected;
      }
    } catch (err) {
      process.stderr.write(
        `dram: OpenAI embedding probe failed: ${(err as Error).message}\n`
      );
    }

    process.stderr.write(
      "dram: OpenAI embeddings unavailable, using keyword search only\n"
    );
    return new NoopEmbedding();
  }

  if (provider === "ollama") {
    const ollamaUrl = process.env.DRAM_OLLAMA_URL || "http://localhost:11434";
    const ollamaModel = model || "nomic-embed-text";

    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const ollama = new OllamaEmbedding({
          baseUrl: ollamaUrl,
          model: ollamaModel,
        });
        try {
          const test = await ollama.embed(["test"]);
          if (test[0] && test[0].length > 0) {
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
