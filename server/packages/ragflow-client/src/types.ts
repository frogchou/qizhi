import type { Evidence } from '../../agent-protocol/src/index.js';

export type RagflowDataset = {
  id: string;
  name: string;
};

export type RagflowChunk = {
  id: string;
  datasetId?: string;
  documentId?: string;
  title?: string;
  content: string;
  similarity?: number;
};

export type RetrievalRequest = {
  question: string;
  datasetIds: string[];
  pageSize?: number;
};

export type RagflowClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
};

export type { Evidence };
