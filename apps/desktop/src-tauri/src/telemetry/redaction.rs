pub fn redact_message(message: &str) -> String {
    message
        .split_whitespace()
        .map(|token| {
            if token.contains("secret") || token.starts_with("sk-") || token.starts_with("apikey_")
            {
                "[REDACTED]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
