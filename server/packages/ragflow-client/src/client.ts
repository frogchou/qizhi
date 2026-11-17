import type { Evidence } from '../../agent-protocol/src/index.js';

import type { RagflowChunk, RagflowClientOptions, RagflowDataset, RetrievalRequest } from './types.js';

type RagflowEnvelope<T> = {
  code: number;
  message?: string;
  data?: T;
};

type RagflowChunkWire = {
  id?: string;
  dataset_id?: string;
  document_id?: string;
  document_keyword?: string;
  content?: string;
  similarity?: number;
};

export class RagflowHttpError extends Error {
  public constructor(endpoint: string, status: number) {
    super(`RAGFlow request to ${endpoint} failed with HTTP ${status}.`);
    this.name = 'RagflowHttpError';
  }
}

export class RagflowBusinessError extends Error {
  public constructor(endpoint: string, code: number, message?: string) {
    super(`RAGFlow request to ${endpoint} returned business code ${code}${message ? `: ${message}` : ''}.`);
    this.name = 'RagflowBusinessError';
  }
}

/** Read-only RAGFlow API adapter. It never logs or serializes its API key. */
export class RagflowClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  public constructor(options: RagflowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  public async listDatasets(): Promise<RagflowDataset[]> {
    const envelope = await this.request<unknown[]>('/api/v1/datasets');
    return (envelope.data ?? []).map((dataset) => {
      const value = dataset as { id?: unknown; name?: unknown };
      return { id: String(value.id ?? ''), name: String(value.name ?? '') };
    }).filter((dataset) => dataset.id.length > 0);
  }

  public async retrieve(request: RetrievalRequest): Promise<RagflowChunk[]> {
    if (!request.question.trim()) throw new Error('RAGFlow retrieval question must not be empty.');
    if (request.datasetIds.length === 0) throw new Error('RAGFlow retrieval requires at least one dataset ID.');

    const envelope = await this.request<{ chunks?: RagflowChunkWire[] }>('/api/v1/retrieval', {
      method: 'POST',
      body: JSON.stringify({
        question: request.question,
        dataset_ids: request.datasetIds,
        page: 1,
        page_size: request.pageSize ?? 10,
      }),
    });

    return (envelope.data?.chunks ?? []).map((chunk, index) => ({
      id: chunk.id ?? `chunk-${index + 1}`,
      datasetId: chunk.dataset_id,
      documentId: chunk.document_id,
      title: chunk.document_keyword,
      content: chunk.content ?? '',
      similarity: chunk.similarity,
    }));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<RagflowEnvelope<T>> {
    const endpoint = `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(endpoint, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new RagflowHttpError(path, response.status);

    const envelope = await response.json() as RagflowEnvelope<T>;
    if (envelope.code !== 0) throw new RagflowBusinessError(path, envelope.code, envelope.message);
    return envelope;
  }
}

/** Convert retrieved knowledge into the Protocol v1 evidence contract. */
export function toEvidence(chunks: RagflowChunk[]): Evidence[] {
  return chunks.map((chunk) => ({
    source: `ragflow:${chunk.documentId ?? 'unknown'}:${chunk.id}`,
    ...(chunk.datasetId ? { datasetId: chunk.datasetId } : {}),
    ...(chunk.documentId ? { documentId: chunk.documentId } : {}),
    ...(chunk.title ? { title: chunk.title } : {}),
    excerpt: chunk.content,
    ...(chunk.similarity === undefined ? {} : { similarity: chunk.similarity }),
  }));
}
