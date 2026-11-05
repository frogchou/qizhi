# RAGFlow Integration

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module wraps the RAGFlow HTTP API: connection checks, dataset/Agent discovery, retrieval, native streaming Agent events, file upload/download, and parsing start.

RAGFlow versions may return different envelope shapes, so parsers accept verified variants while preserving strict error reporting. Citations, document identifiers, and Agent sessions are normalized here; the frontend never assembles API URLs directly.
