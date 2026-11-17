# RAGFlow knowledge-query agent

This is an independently runnable, read-only `knowledge.retrieve` agent. It
retrieves cited evidence from the existing RAGFlow knowledge base and writes
only its own task result under the task workspace.

## Lifecycle

1. The node manager discovers `agent.yaml` statically; no TypeScript is run.
2. The control plane records this exact version as `pending_review`.
3. Only after administrator approval may the node manager execute
   `src/self-check.ts`. The self-check validates configuration shape only and
   never retrieves enterprise content.
4. A leased `TaskEnvelope` starts `src/main.ts`. It emits ordered `started`,
   `progress`, `checkpoint`, and `completed` callbacks using its lease token.
5. The shared Agent Runtime writes `nodes/<node-key>/result.json` atomically and
   posts `{ leaseToken, result }` to the result callback. The control plane
   accepts it only while the attempt owns the lease.

## Input/output

Input is `input.query` (non-empty string). The configured `RAGFLOW_DATASET_IDS`
selects the allowed datasets; when it is absent the control plane first lists
the datasets accessible to its service key. It is not planner-controlled. Results contain
protocol evidence (`source`, dataset/document ids, excerpt and similarity) and
`no_evidence` when no chunks are found. No retrieval or result includes an API
key.

Datasets are queried one at a time and evidence is merged. This allows one
enterprise task to span RAGFlow datasets that use different embedding models.

## Local commands

- `corepack pnpm agent:validate agents/ragflow-knowledge/agent.yaml` validates
  the static manifest.
- `tsx src/self-check.ts` is the post-approval configuration-only check.
