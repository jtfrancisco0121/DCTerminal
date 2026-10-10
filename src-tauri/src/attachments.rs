//! Images pasted into a Claude chat, staged until the next send.
//!
//! Files live under `<app data>/attachments/<tabId>/<id>.<ext>`, never in the
//! user's folder. A send names ids; the bytes are read back here, base64
//! encoded into ACP image content blocks, and deleted after the turn. Folders
//! of tabs that no longer exist are removed at startup.

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Image types the ACP spec lists for image content blocks.
pub const IMAGE_MIMES: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_IMAGES_PER_MESSAGE: usize = 5;

/// One image ready for `session/prompt`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptImage {
    pub mime: String,
    pub data_base64: String,
}

impl PromptImage {
    /// ACP `ContentBlock::Image`.
    pub fn content_block(&self) -> Value {
        json!({ "type": "image", "mimeType": self.mime, "data": self.data_base64 })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    pub mime: String,
    pub bytes: usize,
}

fn extension_for(mime: &str) -> Option<&'static str> {
    IMAGE_MIMES
        .iter()
        .find(|(known, _)| *known == mime)
        .map(|(_, ext)| *ext)
}

pub fn validate_image(mime: &str, bytes: usize) -> Result<(), String> {
    if extension_for(mime).is_none() {
        return Err(format!(
            "Only PNG, JPEG, GIF and WebP images can be attached (got {mime})."
        ));
    }
    if bytes == 0 {
        return Err("The image is empty.".to_string());
    }
    if bytes > MAX_IMAGE_BYTES {
        return Err(format!(
            "Images must be 5 MB or smaller (this one is {:.1} MB).",
            bytes as f64 / (1024.0 * 1024.0)
        ));
    }
    Ok(())
}

pub fn validate_count(count: usize) -> Result<(), String> {
    if count > MAX_IMAGES_PER_MESSAGE {
        return Err(format!(
            "At most {MAX_IMAGES_PER_MESSAGE} images can go with one message."
        ));
    }
    Ok(())
}

/// Tab ids and attachment ids become path segments, so only plain ids pass.
fn plain_id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("bad id: {value}"));
    }
    Ok(value)
}

fn new_attachment_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("img_{nanos:x}_{seq:x}")
}

pub struct AttachmentStore {
    root: PathBuf,
}

impl AttachmentStore {
    /// Opens `<data>/attachments` and drops folders of tabs not in `keep`.
    pub fn open(data_dir: &Path, keep: &[String]) -> Self {
        let root = data_dir.join("attachments");
        crate::turn_changes::prune(&root, keep);
        Self { root }
    }

    fn tab_dir(&self, tab_id: &str) -> Result<PathBuf, String> {
        Ok(self.root.join(plain_id(tab_id)?))
    }

    fn find(&self, tab_id: &str, id: &str) -> Result<Option<(PathBuf, &'static str)>, String> {
        let dir = self.tab_dir(tab_id)?;
        let id = plain_id(id)?;
        for (mime, ext) in IMAGE_MIMES {
            let path = dir.join(format!("{id}.{ext}"));
            if path.is_file() {
                return Ok(Some((path, mime)));
            }
        }
        Ok(None)
    }

    pub fn add(&self, tab_id: &str, mime: &str, data_base64: &str) -> Result<AttachmentInfo, String> {
        let mime = mime.trim().to_ascii_lowercase();
        let ext = extension_for(&mime).ok_or_else(|| {
            format!("Only PNG, JPEG, GIF and WebP images can be attached (got {mime}).")
        })?;
        // Base64 is 4/3 the size: refuse a huge paste before decoding it.
        let approx = data_base64.len() / 4 * 3;
        if approx > MAX_IMAGE_BYTES + 3 {
            validate_image(&mime, approx)?;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|err| format!("The image data could not be read ({err})."))?;
        validate_image(&mime, bytes.len())?;
        let dir = self.tab_dir(tab_id)?;
        std::fs::create_dir_all(&dir).map_err(|err| format!("attachments dir: {err}"))?;
        let id = new_attachment_id();
        std::fs::write(dir.join(format!("{id}.{ext}")), &bytes)
            .map_err(|err| format!("could not stage the image: {err}"))?;
        Ok(AttachmentInfo {
            id,
            mime,
            bytes: bytes.len(),
        })
    }

    pub fn remove(&self, tab_id: &str, id: &str) -> Result<(), String> {
        if let Some((path, _)) = self.find(tab_id, id)? {
            std::fs::remove_file(path).map_err(|err| err.to_string())?;
        }
        Ok(())
    }

    /// Best-effort cleanup after a send.
    pub fn remove_many(&self, tab_id: &str, ids: &[String]) {
        for id in ids {
            let _ = self.remove(tab_id, id);
        }
    }

    /// Read staged images for a send, re-checking every limit.
    pub fn load(&self, tab_id: &str, ids: &[String]) -> Result<Vec<PromptImage>, String> {
        validate_count(ids.len())?;
        let mut images = Vec::with_capacity(ids.len());
        for id in ids {
            let (path, mime) = self
                .find(tab_id, id)?
                .ok_or_else(|| "An attached image is gone — attach it again.".to_string())?;
            let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
            validate_image(mime, bytes.len())?;
            images.push(PromptImage {
                mime: mime.to_string(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
        Ok(images)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dct-attach-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn only_the_four_image_types_pass() {
        for mime in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            assert!(validate_image(mime, 10).is_ok(), "{mime}");
        }
        for mime in ["image/svg+xml", "image/bmp", "text/plain", ""] {
            assert!(validate_image(mime, 10).is_err(), "{mime}");
        }
    }

    #[test]
    fn size_limit_is_five_megabytes() {
        assert!(validate_image("image/png", MAX_IMAGE_BYTES).is_ok());
        let err = validate_image("image/png", MAX_IMAGE_BYTES + 1).unwrap_err();
        assert!(err.contains("5 MB"));
        assert!(validate_image("image/png", 0).is_err());
    }

    #[test]
    fn at_most_five_per_message() {
        assert!(validate_count(5).is_ok());
        assert!(validate_count(6).unwrap_err().contains('5'));
    }

    #[test]
    fn image_block_matches_the_acp_shape() {
        let image = PromptImage {
            mime: "image/png".into(),
            data_base64: "AAAA".into(),
        };
        assert_eq!(
            image.content_block(),
            json!({ "type": "image", "mimeType": "image/png", "data": "AAAA" })
        );
    }

    #[test]
    fn add_load_and_remove_round_trip() {
        let data = temp_root("roundtrip");
        let store = AttachmentStore::open(&data, &[]);
        let info = store.add("tab_1", "image/PNG", &b64(b"\x89PNGdata")).unwrap();
        assert_eq!(info.mime, "image/png");
        assert_eq!(info.bytes, 8);
        assert!(data
            .join("attachments/tab_1")
            .join(format!("{}.png", info.id))
            .is_file());
        let images = store.load("tab_1", std::slice::from_ref(&info.id)).unwrap();
        assert_eq!(images[0].data_base64, b64(b"\x89PNGdata"));
        store.remove_many("tab_1", std::slice::from_ref(&info.id));
        assert!(store.load("tab_1", &[info.id]).is_err());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn add_refuses_bad_type_and_bad_data() {
        let data = temp_root("refuse");
        let store = AttachmentStore::open(&data, &[]);
        assert!(store.add("tab_1", "image/svg+xml", &b64(b"<svg/>")).is_err());
        assert!(store.add("tab_1", "image/png", "not base64!").is_err());
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        assert!(store.add("tab_1", "image/png", &b64(&big)).is_err());
        assert!(store.add("tab_1", "image/gif", &b64(b"GIF89a")).is_ok());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_send_with_six_images_is_refused() {
        let data = temp_root("six");
        let store = AttachmentStore::open(&data, &[]);
        let ids: Vec<String> = (0..MAX_IMAGES_PER_MESSAGE + 1)
            .map(|_| store.add("tab_1", "image/gif", &b64(b"GIF89a")).unwrap().id)
            .collect();
        assert!(store.load("tab_1", &ids).is_err());
        assert_eq!(store.load("tab_1", &ids[..5]).unwrap().len(), 5);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn ids_cannot_escape_the_attachments_folder() {
        let data = temp_root("escape");
        let store = AttachmentStore::open(&data, &[]);
        assert!(store.add("../x", "image/png", &b64(b"x")).is_err());
        assert!(store.remove("tab_1", "../../secret").is_err());
        assert!(store.load("tab_1", &["a/b".into()]).is_err());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn open_prunes_gone_tabs() {
        let data = temp_root("prune");
        let store = AttachmentStore::open(&data, &[]);
        store.add("tab_gone", "image/png", &b64(b"x")).unwrap();
        store.add("tab_kept", "image/png", &b64(b"x")).unwrap();
        AttachmentStore::open(&data, &["tab_kept".into()]);
        assert!(!data.join("attachments/tab_gone").exists());
        assert!(data.join("attachments/tab_kept").exists());
        let _ = std::fs::remove_dir_all(&data);
    }
}
