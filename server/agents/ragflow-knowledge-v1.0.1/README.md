# RAGFlow knowledge-query agent 1.0.1

This directory is the immutable release package for `ragflow-knowledge@1.0.1`.
It is separate from the reviewed 1.0.0 package so an unapproved code change
cannot be launched under an older approved version.

## Approval boundary

Discovery reads only `agent.yaml` and the two JSON Schemas. After an
administrator approves this exact version, the node manager runs
`../../node_modules/.bin/tsx src/self-check.ts`. This package check needs no
RAGFlow credential, reads no enterprise content, and verifies only that the
reviewed package can launch.

For a leased task, the scheduler injects the RAGFlow URL, service key and
allowed dataset ids through a protected per-instance environment file. The
agent validates those values at the runtime boundary, retrieves only from its
allowed datasets, and writes results only into the task workspace.

Do not modify a reviewed release directory. Publish a code change in a new
top-level versioned package directory and request approval for that precise
version.
