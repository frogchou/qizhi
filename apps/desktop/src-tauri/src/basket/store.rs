use crate::{codex::ensure_regular_source, database::Database};
use rusqlite::OptionalExtension;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

pub(super) const STORAGE: &str = "无法访问资料筐，请检查本机数据目录与磁盘空间。";
pub(super) const SOURCE: &str = "无法读取所选原件，请检查来源后重试。";
const CORRUPT: &str = "资料快照已损坏或缺失，请从来源重新加入。";
const COLUMNS: &str = "id,kind,display_name,source_label,size_bytes,sha256,added_at_utc_ms";
#[derive(Clone)]
pub struct Basket {
    pub(super) db: Database,
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BasketItem {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub source_label: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub added_at_utc_ms: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasketResult {
    pub key: String,
    pub display_name: String,
    pub status: &'static str,
    pub item: Option<BasketItem>,
    pub error: Option<String>,
}
impl BasketResult {
    pub(super) fn failed(key: String, display_name: String, error: String) -> Self {
        Self {
            key,
            display_name,
            status: "failed",
            item: None,
            error: Some(error),
        }
    }
}
pub struct OpenSnapshot {
    pub item: BasketItem,
    pub file: File,
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<BasketItem> {
    Ok(BasketItem {
        id: r.get(0)?,
        kind: r.get(1)?,
        display_name: r.get(2)?,
        source_label: r.get(3)?,
        size_bytes: r.get(4)?,
        sha256: r.get(5)?,
        added_at_utc_ms: r.get(6)?,
    })
}
pub(super) fn digest_text(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub(crate) fn copy_hash(
    mut source: impl Read,
    mut destination: impl Write,
) -> std::io::Result<(String, i64)> {
    let mut hash = Sha256::new();
    let mut size = 0i64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = source.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        destination.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
        size += n as i64;
    }
    Ok((format!("{:x}", hash.finalize()), size))
}
fn id_valid(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id)
}
fn safe_open(path: &Path) -> Result<File, String> {
    ensure_regular_source(path).map_err(|_| SOURCE)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x1 | 0x4);
    }
    options.open(path).map_err(|_| SOURCE.into())
}
pub(crate) fn selected_file(path: &Path) -> Result<File, String> {
    safe_open(path)
}
impl Basket {
    pub fn new(db: Database, root: PathBuf) -> Self {
        Self {
            db,
            root,
            gate: Arc::new(Mutex::new(())),
        }
    }
    pub(super) fn list(&self) -> Result<Vec<BasketItem>, String> {
        self.db
            .with_connection(|db| {
                let mut stmt = db.prepare(&format!(
                    "SELECT {COLUMNS} FROM material_basket ORDER BY added_at_utc_ms DESC,id"
                ))?;
                stmt.query_map([], row)?.collect()
            })
            .map_err(|_| STORAGE.into())
    }
    fn info(&self, id: &str) -> Result<BasketItem, String> {
        if !id_valid(id) {
            return Err("资料筐项目无效。".into());
        }
        self.db
            .with_connection(|db| {
                db.query_row(
                    &format!("SELECT {COLUMNS} FROM material_basket WHERE id=?1"),
                    [id],
                    row,
                )
                .optional()
            })
            .map_err(|_| STORAGE)?
            .ok_or_else(|| "资料已从筐中移除，请重新选择。".into())
    }
    pub fn open(&self, id: &str) -> Result<OpenSnapshot, String> {
        let _guard = self.gate.lock().map_err(|_| STORAGE)?;
        let item = self.info(id)?;
        let mut file = safe_open(&self.root.join(&item.id)).map_err(|_| CORRUPT)?;
        let (hash, size) = copy_hash(&mut file, std::io::sink()).map_err(|_| CORRUPT)?;
        if hash != item.sha256 || size != item.size_bytes {
            return Err(CORRUPT.into());
        }
        file.rewind().map_err(|_| CORRUPT)?;
        Ok(OpenSnapshot { item, file })
    }
    pub(super) fn add(
        &self,
        key: String,
        kind: &str,
        label: &str,
        name: &str,
        mut source: impl Read,
    ) -> Result<BasketResult, String> {
        let name = crate::factory::suggested_name(name);
        fs::create_dir_all(&self.root).map_err(|_| STORAGE)?;
        let mut pending = NamedTempFile::new_in(&self.root).map_err(|_| STORAGE)?;
        let (hash, size) = copy_hash(&mut source, &mut pending)
            .map_err(|_| "资料复制失败，请检查原件和剩余磁盘空间。")?;
        pending.as_file().sync_all().map_err(|_| STORAGE)?;
        let _guard = self.gate.lock().map_err(|_| STORAGE)?;
        let source_key = digest_text(&key);
        let existing = self
            .db
            .with_connection(|db| {
                db.query_row(
                    &format!(
                        "SELECT {COLUMNS} FROM material_basket WHERE source_key=?1 AND sha256=?2"
                    ),
                    (&source_key, &hash),
                    row,
                )
                .optional()
            })
            .map_err(|_| STORAGE)?;
        if let Some(item) = existing {
            // Re-adding also repairs a missing or corrupted snapshot.
            pending
                .persist(self.root.join(&item.id))
                .map_err(|_| STORAGE)?;
            return Ok(BasketResult {
                key: item.id.clone(),
                display_name: item.display_name.clone(),
                status: "existing",
                item: Some(item),
                error: None,
            });
        }
        let item = BasketItem {
            id: Uuid::new_v4().to_string(),
            kind: kind.to_owned(),
            display_name: name.clone(),
            source_label: label.to_owned(),
            size_bytes: size,
            sha256: hash,
            added_at_utc_ms: chrono::Utc::now().timestamp_millis(),
        };
        let dest = self.root.join(&item.id);
        // Publish bytes before metadata. If process or disk fails beforehand, no visible item is partial.
        pending.persist_noclobber(&dest).map_err(|_| STORAGE)?;
        let result=self.db.with_connection(|db|db.execute("INSERT INTO material_basket(id,kind,display_name,source_label,source_key,size_bytes,sha256,added_at_utc_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", rusqlite::params![item.id,item.kind,item.display_name,item.source_label,source_key,item.size_bytes,item.sha256,item.added_at_utc_ms]).map(|_|()));
        if result.is_err() {
            let _ = fs::remove_file(&dest);
            return Err(STORAGE.into());
        }
        Ok(BasketResult {
            key: item.id.clone(),
            display_name: name,
            status: "added",
            item: Some(item),
            error: None,
        })
    }
    pub(super) fn local(
        &self,
        kind: &str,
        label: &str,
        path: &Path,
    ) -> Result<BasketResult, String> {
        let source = safe_open(path)?;
        let canonical = path.canonicalize().map_err(|_| SOURCE)?;
        let mut identity = canonical.to_string_lossy().into_owned();
        if cfg!(windows) {
            identity.make_ascii_lowercase();
        }
        self.add(
            format!("local:{identity}"),
            kind,
            label,
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("本地文件"),
            source,
        )
    }
    fn erase_locked(&self, ids: &[String]) -> Result<(), String> {
        if ids.iter().any(|id| !id_valid(id)) {
            return Err("资料筐项目无效。".into());
        }
        self.db
            .with_transaction(|t| {
                for id in ids {
                    t.execute("DELETE FROM material_basket WHERE id=?1", [id])?;
                }
                Ok(())
            })
            .map_err(|_| STORAGE)?;
        for id in ids {
            let path = self.root.join(id);
            if let Err(e) = fs::remove_file(&path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                return Err(
                    "资料已移除，本地快照暂时被占用，请关闭占用文件后重新清空资料筐。".into(),
                );
            }
        }
        Ok(())
    }
    pub(super) fn remove(&self, ids: &[String]) -> Result<(), String> {
        let _g = self.gate.lock().map_err(|_| STORAGE)?;
        self.erase_locked(ids)
    }
    pub(super) fn clear(&self) -> Result<(), String> {
        let _g = self.gate.lock().map_err(|_| STORAGE)?;
        let ids = self.list()?.into_iter().map(|i| i.id).collect::<Vec<_>>();
        self.erase_locked(&ids)?;
        self.purge_orphans()
    }
    pub(crate) fn purge_orphans(&self) -> Result<(), String> {
        let known = self
            .list()?
            .into_iter()
            .map(|i| i.id)
            .collect::<std::collections::HashSet<_>>();
        if !self.root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&self.root).map_err(|_| STORAGE)? {
            let entry = entry.map_err(|_| STORAGE)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if id_valid(&name) && !known.contains(&name) {
                fs::remove_file(entry.path()).map_err(|_| STORAGE)?;
            }
        }
        Ok(())
    }
}
