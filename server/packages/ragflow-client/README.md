# RAGFlow read-only client

This package is the sole initial integration boundary for the existing
enterprise knowledge base. It uses only `GET /api/v1/datasets` and
`POST /api/v1/retrieval`; it never writes, deletes, or updates knowledge.

## Configuration and secret handling

The caller supplies `RAGFLOW_BASE_URL` and `RAGFLOW_API_KEY` through the
root-owned runtime environment. The client places the key only in the outbound
`Authorization: Bearer` header. Error classes include endpoint metadata and
business code but never include request headers or the key.

## Returned fields

`RagflowDataset` exposes `id` and `name`. `RagflowChunk` normalizes the source
fields RAGFlow returns: `id`, `datasetId`, `documentId`, `title`, `content`,
and optional `similarity`. `toEvidence` converts chunks into Agent Protocol v1
evidence with a stable `ragflow:<documentId>:<chunkId>` source, preserving
dataset/document identifiers, excerpt and similarity for later audit.

## Success criterion

An HTTP success alone is insufficient. Both endpoints must return a JSON
envelope with `code: 0`; any nonzero business `code` becomes
`RagflowBusinessError` so the control plane does not treat unavailable
knowledge as empty evidence.
