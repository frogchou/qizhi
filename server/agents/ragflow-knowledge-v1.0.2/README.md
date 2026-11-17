# RAGFlow knowledge-query agent 1.0.2

This immutable release corrects the reviewed result schema for
`ragflow-knowledge`: evidence is an array with a fully declared item shape.
It is a separate package and must be discovered, reviewed and approved before
the control plane can use it.

The approval self-check reads no enterprise data. A leased execution receives
the RAGFlow URL, service key and allowed datasets only through its protected
per-instance environment file, then writes results only in the task workspace.

`RAGFLOW_DATASET_IDS` is an explicit comma-separated allowlist and must not be
empty for a leased query. This release deliberately does not fall back to all
datasets visible to the key: expanding the scope is an administrator
configuration decision, not an implicit agent behavior.
