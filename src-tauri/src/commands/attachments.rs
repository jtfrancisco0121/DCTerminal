//! Stage and unstage pasted chat images (app data only; see `crate::attachments`).

use crate::attachments::{AttachmentInfo, AttachmentStore, DroppedImage};
use tauri::State;

/// Stage one image for the tab's next send. `data` is base64 without a
/// `data:` prefix.
#[tauri::command]
pub async fn attachment_add(
    tab_id: String,
    mime: String,
    data: String,
    store: State<'_, AttachmentStore>,
) -> Result<AttachmentInfo, String> {
    store.add(&tab_id, &mime, &data)
}

#[tauri::command]
pub fn attachment_remove(
    tab_id: String,
    id: String,
    store: State<AttachmentStore>,
) -> Result<(), String> {
    store.remove(&tab_id, &id)
}

/// Read an image file dropped on the chat composer (see `DroppedImage`).
#[tauri::command]
pub async fn attachment_read_file(path: String) -> Result<DroppedImage, String> {
    crate::attachments::read_image_file(std::path::Path::new(&path))
}
