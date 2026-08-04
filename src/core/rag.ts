import type OpenAI from "openai";

// ─── 类型定义 ───────────────────────────────────────────────

/** 文档块：内容 + 向量 + 元数据。 */
export interface Document {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

// ─── Chunker：文本分块 ──────────────────────────────────────

export interface ChunkOptions {
  /** 每块最大字符数。默认 500。 */
  chunkSize?: number;
  /** 块之间重叠字符数，避免切断语义。默认 50。 */
  overlap?: number;
}

/**
 * 文本分块。先按段落切，段落超长再按 chunkSize 硬切。
 * 相邻块之间保留 overlap 字符的重叠，确保语义连续性。
 */
export function chunkText(text: string, options?: ChunkOptions): string[] {
  const { chunkSize = 500, overlap = 50 } = options ?? {};

  // 先按空行分段
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const chunks: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= chunkSize) {
      // 段落够短，整块加入
      chunks.push(para.trim());
    } else {
      // 段落太长，按 chunkSize 硬切，带 overlap
      for (let i = 0; i < para.length; i += chunkSize - overlap) {
        const chunk = para.slice(i, i + chunkSize).trim();
        if (chunk.length > 0) {
          chunks.push(chunk);
        }
        // 如果剩余不足 overlap，结束
        if (i + chunkSize >= para.length) break;
      }
    }
  }

  return chunks;
}

// ─── Embedder：向量化 ──────────────────────────────────────

export interface BaseEmbedder {
  /** 单条文本向量化。 */
  embed(text: string): Promise<number[]>;
  /** 批量向量化。 */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI Embedding 适配器。
 * 默认使用 text-embedding-3-small（1536 维，便宜）。
 */
export class OpenAIEmbedder implements BaseEmbedder {
  constructor(
    private client: OpenAI,
    private model: string = "text-embedding-3-small",
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return res.data[0]?.embedding ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    // API 返回顺序可能不保证，按 index 排序
    return res.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/**
 * 本地哈希嵌入器（零依赖 fallback）。
 * 用 n-gram + hash trick 生成稀疏向量，L2 归一化后用余弦相似度。
 * 精度不如真实 embedding 模型，但足够演示 RAG 流程，且无需外部 API。
 */
export class HashEmbedder implements BaseEmbedder {
  constructor(private dim = 256) {}

  private tokenize(text: string): string[] {
    // 中文按字符切，英文按单词切
    const tokens: string[] = [];
    // 提取英文单词
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    tokens.push(...words);
    // 提取中文字符的 bigram
    const chars = text.match(/[\u4e00-\u9fff]/g) ?? [];
    for (let i = 0; i < chars.length - 1; i++) {
      tokens.push(chars[i]! + chars[i + 1]!);
    }
    return tokens;
  }

  private hash(token: string): number {
    let h = 0;
    for (let i = 0; i < token.length; i++) {
      h = (h * 31 + token.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % this.dim;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array(this.dim).fill(0);
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      vec[this.hash(token)]! += 1;
    }
    // L2 归一化
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) {
        vec[i] = vec[i]! / norm;
      }
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ─── VectorStore：存储 + 检索 ──────────────────────────────

export interface VectorStore {
  /** 添加文档（含向量）。 */
  add(docs: Document[]): Promise<void>;
  /** 按向量相似度检索 top-K。 */
  search(query: number[], topK: number): Promise<Document[]>;
  /** 文档总数。 */
  size(): number;
  /** 清空。 */
  clear(): void;
}

/** 余弦相似度。 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 内存向量存储。零依赖，用数组 + 余弦相似度。
 * 适合学习和中小规模文档（几千条以内）。
 */
export class MemoryVectorStore implements VectorStore {
  private docs: Document[] = [];

  async add(docs: Document[]): Promise<void> {
    this.docs.push(...docs);
  }

  async search(query: number[], topK: number): Promise<Document[]> {
    const scored = this.docs.map((doc) => ({
      doc,
      score: cosineSimilarity(query, doc.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.doc);
  }

  size(): number {
    return this.docs.length;
  }

  clear(): void {
    this.docs = [];
  }
}

// ─── Retriever：封装检索流程 ───────────────────────────────

export interface Retriever {
  /** 检索与 query 最相关的 top-K 文档。 */
  retrieve(query: string, topK?: number): Promise<Document[]>;
}

/**
 * 向量检索器：embed query → 向量搜索 → 返回文档。
 * 封装了 Embedder + VectorStore 两步，调用方只需一个方法。
 */
export class VectorRetriever implements Retriever {
  constructor(
    private embedder: BaseEmbedder,
    private store: VectorStore,
  ) {}

  async retrieve(query: string, topK = 3): Promise<Document[]> {
    const embedding = await this.embedder.embed(query);
    return this.store.search(embedding, topK);
  }
}

// ─── 工具函数：从文本构建向量库 ─────────────────────────────

export interface IngestOptions extends ChunkOptions {
  /** 来源标记，写入 metadata。 */
  source?: string;
}

/**
 * 一站式：文本 → 分块 → 向量化 → 存入 VectorStore。
 * 返回存入的文档数。
 */
export async function ingestText(
  text: string,
  embedder: BaseEmbedder,
  store: VectorStore,
  options?: IngestOptions,
): Promise<number> {
  const chunks = chunkText(text, options);
  if (chunks.length === 0) return 0;

  const embeddings = await embedder.embedBatch(chunks);
  const docs: Document[] = chunks.map((content, i) => ({
    id: `${options?.source ?? "doc"}-${i}`,
    content,
    embedding: embeddings[i]!,
    metadata: options?.source ? { source: options.source, chunk: i } : { chunk: i },
  }));

  await store.add(docs);
  return docs.length;
}
