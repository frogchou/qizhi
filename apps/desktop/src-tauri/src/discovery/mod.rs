pub mod es_cli;
pub mod everything_sdk;
pub mod native_fs;
pub mod port;
pub mod selector;
pub mod unavailable;
pub use port::{DiscoveryHealth, parse_es_output};
pub use selector::{AdapterAvailability, select_discovery};
