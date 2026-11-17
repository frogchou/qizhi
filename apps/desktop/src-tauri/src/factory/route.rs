use std::collections::HashSet;
use url::form_urlencoded;

const INVALID: &str = "该工厂请求地址或参数无效。";

pub(super) fn valid_id(value: &str) -> bool {
    // Dynamic resource names are single URL segments, including semver build metadata.
    let decoded = value.replace("%2B", "+").replace("%2b", "+");
    !decoded.is_empty()
        && decoded.len() <= 160
        && decoded != "."
        && decoded != ".."
        && decoded
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.+@".contains(&c))
}

fn collection(name: &str) -> bool {
    matches!(
        name,
        "agents"
            | "tasks"
            | "quality"
            | "assets"
            | "runtimes"
            | "sources"
            | "monitor"
            | "deliveries"
            | "packages"
    )
}

fn valid_query(name: &str, query: &str) -> bool {
    let mut seen = HashSet::new();
    !query.is_empty()
        && form_urlencoded::parse(query.as_bytes()).all(|(key, value)| {
            if !seen.insert(key.to_string())
                || value.is_empty()
                || value.len() > 512
                || value.chars().any(char::is_control)
            {
                return false;
            }
            match (name, key.as_ref()) {
                ("changes", "after") => {
                    value.len() <= 192
                        && value
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
                }
                ("changes", "waitMs") => value.parse::<u32>().is_ok_and(|v| v <= 25_000),
                ("changes", _) => false,
                (_, "limit" | "offset") => {
                    value.bytes().all(|c| c.is_ascii_digit()) && value.parse::<u32>().is_ok()
                }
                (
                    _,
                    "state" | "area" | "agentId" | "version" | "sourceSystem" | "taskId" | "status"
                    | "runtime" | "kind" | "source",
                ) => true,
                _ => false,
            }
        })
}

pub(super) fn validate(method: &str, path: &str) -> Result<(), String> {
    if path.len() > 4096 || path.contains(['\\', '#']) || path.chars().any(char::is_control) {
        return Err(INVALID.to_owned());
    }
    let (route, query) = path
        .split_once('?')
        .map_or((path, None), |(a, b)| (a, Some(b)));
    let parts: Vec<_> = route.split('/').collect();
    let allowed = match (method, parts.as_slice(), query) {
        ("GET", ["", "v1", "factory", name], query) if collection(name) || *name == "changes" => {
            query.is_none_or(|q| valid_query(name, q))
        }
        ("GET", ["", "v1", "factory", "overview"], None) => true,
        ("GET", ["", "v1", "factory", "agents", agent, "status"], None)
        | ("POST", ["", "v1", "factory", "agents", agent, "delete"], None) => valid_id(agent),
        ("GET", ["", "v1", "tasks" | "agents"], None) => true,
        ("GET", ["", "v1", "tasks", task] | ["", "v1", "tasks", task, "interactions"], None) => {
            valid_id(task)
        }
        ("GET", ["", "v1", "tasks", task, "interactions", interaction], None) => {
            valid_id(task) && valid_id(interaction)
        }
        ("POST", ["", "v1", "tasks"] | ["", "v1", "factory", "releases"], None) => true,
        ("POST", ["", "v1", "tasks", task, "stop" | "review" | "approve"], None) => valid_id(task),
        (
            "POST",
            [
                "",
                "v1",
                "tasks",
                task,
                "interactions",
                interaction,
                "respond" | "cancel",
            ],
            None,
        ) => valid_id(task) && valid_id(interaction),
        (
            "POST",
            ["", "v1", "agents", agent, "versions", version, "approve"]
            | [
                "",
                "v1",
                "factory",
                "agents",
                agent,
                "versions",
                version,
                "offline",
            ],
            None,
        ) => valid_id(agent) && valid_id(version),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(INVALID.to_owned())
    }
}

pub(super) fn artifact(task: &str, artifact: &str) -> Result<String, String> {
    if !valid_id(task) || !valid_id(artifact) {
        return Err(INVALID.to_owned());
    }
    Ok(format!("/v1/tasks/{task}/artifacts/{artifact}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_expected_routes_and_query_parameters() {
        for path in [
            "/v1/factory/changes?after=ab.x-_2&waitMs=25000",
            "/v1/factory/quality?state=awaiting_review&offset=20&limit=5",
            "/v1/tasks/abc-A/interactions",
            "/v1/factory/agents/alpha/status",
        ] {
            assert!(validate("GET", path).is_ok(), "{path}");
        }
        for path in [
            "/v1/factory/agents/alpha/versions/1.2.3%2Bbuild/offline",
            "/v1/agents/alpha/versions/1.2.3/approve",
            "/v1/factory/releases",
            "/v1/tasks/t/review",
            "/v1/tasks/t/stop",
            "/v1/factory/agents/alpha/delete",
        ] {
            assert!(validate("POST", path).is_ok(), "{path}");
        }
        for path in [
            "//elsewhere/v1/factory/overview",
            "/v1/factory/changes?after=a&after=b",
            "/v1/factory/changes?waitMs=25001",
            "/v1/factory/agents?redirect=http://host",
            "/v1/factory/%2e%2e",
            "/v1/tasks/..",
            "/v1/tasks/a%2Fb",
            "/v1/tasks/t/artifacts/a",
            "/internal/v1/instances",
        ] {
            assert!(validate("GET", path).is_err(), "{path}");
        }
        assert!(validate("POST", "/v1/agents/discover").is_err());
        for (method, path) in [
            ("GET", "/v1/factory/agents/a/delete"),
            ("POST", "/v1/factory/agents/a/status"),
            ("DELETE", "/v1/factory/agents/a/delete"),
            ("POST", "/v1/factory/agents/../delete"),
            ("POST", "/v1/factory/agents/a/delete?force=1"),
            ("POST", "/v1/factory/agents/a/versions/1.0.0/delete"),
            ("GET", "/v1/factory/agents/%2e%2e/status"),
            ("GET", "/v1/tasks/t/stop"),
        ] {
            assert!(validate(method, path).is_err(), "{method} {path}");
        }
        assert!(validate("PUT", "/v1/tasks").is_err());
        assert!(artifact("t", "../a").is_err());
    }
}
