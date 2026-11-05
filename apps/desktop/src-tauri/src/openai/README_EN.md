# OpenAI-Compatible Services

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module calls an OpenAI-compatible Base URL for work summaries and model capability checks. It handles Responses/compatible envelopes, streamed text deltas, truncation notices, and batched summarization after local document extraction.

Model name, Base URL, and credentials come from Settings; the key is read from the credential store. Public errors must never include request bodies, file content, or authorization headers.
