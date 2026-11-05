use serde_json::Value;
use thiserror::Error;

#[derive(Clone, Debug, Error)]
pub enum ProtocolError {
    #[error("invalid JSON-RPC message")]
    InvalidJson,
    #[error("JSON-RPC line exceeds the safety limit")]
    LineTooLarge,
}

#[derive(Clone, Debug)]
pub enum JsonRpcEnvelope {
    Response {
        id: u64,
        result: Option<Value>,
        error: Option<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
}

impl JsonRpcEnvelope {
    pub fn parse(line: &str) -> Result<Self, ProtocolError> {
        let value: Value = serde_json::from_str(line).map_err(|_| ProtocolError::InvalidJson)?;
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let raw_id = value.get("id").cloned();
        let response_id = value.get("id").and_then(Value::as_u64);
        match (raw_id, response_id, method) {
            (Some(id), _, Some(method)) => Ok(Self::ServerRequest {
                id,
                method,
                params: value.get("params").cloned().unwrap_or(Value::Null),
            }),
            (None, _, Some(method)) => Ok(Self::Notification {
                method,
                params: value.get("params").cloned().unwrap_or(Value::Null),
            }),
            (_, Some(id), None) => Ok(Self::Response {
                id,
                result: value.get("result").cloned(),
                error: value.get("error").cloned(),
            }),
            _ => Err(ProtocolError::InvalidJson),
        }
    }
}

pub struct JsonLineFramer {
    buffer: Vec<u8>,
    maximum_line_bytes: usize,
}

impl JsonLineFramer {
    pub fn new(maximum_line_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            maximum_line_bytes,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, ProtocolError> {
        self.buffer.extend_from_slice(bytes);
        let mut lines = Vec::new();
        while let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
            if position > self.maximum_line_bytes {
                return Err(ProtocolError::LineTooLarge);
            }
            let mut line = self.buffer.drain(..=position).collect::<Vec<_>>();
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            if !line.is_empty() {
                lines.push(String::from_utf8(line).map_err(|_| ProtocolError::InvalidJson)?);
            }
        }
        if self.buffer.len() > self.maximum_line_bytes {
            return Err(ProtocolError::LineTooLarge);
        }
        Ok(lines)
    }
}
