import { describe, expect, it, vi } from 'vitest';

import { RagflowBusinessError, RagflowClient, toEvidence } from '../../packages/ragflow-client/src/index';

const apiKey = 'test-ragflow-key-not-a-real-secret';

describe('RagflowClient', () => {
  it('lists datasets with bearer authentication without leaking the token on an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 503 }));
    const client = new RagflowClient({ baseUrl: 'http://ragflow.internal', apiKey, fetch: fetchMock });

    await expect(client.listDatasets()).rejects.toThrow(/503/);
    await expect(client.listDatasets()).rejects.not.toThrow(apiKey);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ragflow.internal/api/v1/datasets',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${apiKey}` }) }),
    );
  });

  it('retrieves chunks through the documented read-only endpoint and maps cited evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { chunks: [{ id: 'chunk-1', dataset_id: 'dataset-1', document_id: 'doc-1', document_keyword: '味道府资料', content: '客户介绍', similarity: 0.92 }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new RagflowClient({ baseUrl: 'http://ragflow.internal/', apiKey, fetch: fetchMock });

    const chunks = await client.retrieve({ question: '味道府是什么？', datasetIds: ['dataset-1'], pageSize: 8 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://ragflow.internal/api/v1/retrieval',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ question: '味道府是什么？', dataset_ids: ['dataset-1'], page: 1, page_size: 8 }),
      }),
    );
    expect(toEvidence(chunks)).toEqual([expect.objectContaining({
      source: 'ragflow:doc-1:chunk-1', datasetId: 'dataset-1', documentId: 'doc-1', title: '味道府资料', excerpt: '客户介绍', similarity: 0.92,
    })]);
  });

  it('treats HTTP 200 plus nonzero business code as a retrieval failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 102, message: 'dataset unavailable' }), { status: 200 }));
    const client = new RagflowClient({ baseUrl: 'http://ragflow.internal', apiKey, fetch: fetchMock });

    await expect(client.retrieve({ question: 'test', datasetIds: ['dataset-1'] })).rejects.toBeInstanceOf(RagflowBusinessError);
  });
});
