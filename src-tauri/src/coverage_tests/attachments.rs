//! Staged chat images: type and size limits, and ids that try to leave
//! `<data>/attachments/<tab>`.

use crate::attachments::{AttachmentStore, MAX_IMAGE_BYTES};
use crate::test_support::{names_in, TempDir};
use base64::Engine;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

const BAD_IDS: [&str; 10] = [
    "..", ".", "../x", "a/b", r"a\b", "", "tab 1", "tab.png", "tåb", "a\0b",
];

#[test]
fn every_path_like_tab_id_is_refused_and_nothing_is_written() {
    let data = TempDir::new("att_tab_ids");
    let store = AttachmentStore::open(data.path(), &[]);
    let long = "t".repeat(65);
    for bad in BAD_IDS.iter().copied().chain([long.as_str()]) {
        assert!(store.add(bad, "image/png", &b64(b"x")).is_err(), "{bad:?}");
        assert!(store.remove(bad, "img_1").is_err(), "{bad:?}");
        assert!(store.load(bad, &["img_1".into()]).is_err(), "{bad:?}");
    }
    assert!(
        names_in(data.path()).is_empty(),
        "{:?}",
        names_in(data.path())
    );
    // 64 plain characters are fine.
    assert!(store.add(&"t".repeat(64), "image/png", &b64(b"x")).is_ok());
}

#[test]
fn every_path_like_attachment_id_is_refused() {
    let data = TempDir::new("att_ids");
    let outside = data.join("secret.png");
    std::fs::write(&outside, b"outside").unwrap();
    let store = AttachmentStore::open(data.path(), &[]);
    store.add("tab_1", "image/png", &b64(b"in")).unwrap();
    for bad in BAD_IDS
        .iter()
        .copied()
        .chain(["../../secret", "../../../secret"])
    {
        assert!(store.remove("tab_1", bad).is_err(), "{bad:?}");
        assert!(store.load("tab_1", &[bad.to_string()]).is_err(), "{bad:?}");
    }
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
}

#[test]
fn mime_types_are_normalized_and_only_four_pass() {
    let data = TempDir::new("att_mime");
    let store = AttachmentStore::open(data.path(), &[]);
    let info = store.add("tab_1", "  IMAGE/PNG ", &b64(b"png")).unwrap();
    assert_eq!(info.mime, "image/png");
    assert_eq!(info.bytes, 3);
    let jpeg = store.add("tab_1", "image/jpeg", &b64(b"jpg")).unwrap();
    assert!(data
        .join("attachments")
        .join("tab_1")
        .join(format!("{}.jpg", jpeg.id))
        .is_file());
    for bad in [
        "image/jpg",
        "image/svg+xml",
        "text/html",
        "",
        "image/png; charset=x",
    ] {
        let err = store.add("tab_1", bad, &b64(b"x")).unwrap_err();
        assert!(err.contains("PNG, JPEG, GIF and WebP"), "{bad:?}: {err}");
    }
}

#[test]
fn the_size_limit_is_exact_and_empty_images_are_refused() {
    let data = TempDir::new("att_size");
    let store = AttachmentStore::open(data.path(), &[]);
    let at_limit = vec![7u8; MAX_IMAGE_BYTES];
    let info = store.add("tab_1", "image/webp", &b64(&at_limit)).unwrap();
    assert_eq!(info.bytes, MAX_IMAGE_BYTES);
    let over = vec![7u8; MAX_IMAGE_BYTES + 1];
    let err = store.add("tab_1", "image/webp", &b64(&over)).unwrap_err();
    assert!(err.contains("5 MB"), "{err}");
    assert!(store
        .add("tab_1", "image/gif", "")
        .unwrap_err()
        .contains("empty"));
    assert!(store
        .add("tab_1", "image/gif", "not base64!!")
        .unwrap_err()
        .contains("could not be read"));
    // Surrounding whitespace from a paste is fine.
    assert!(store
        .add("tab_1", "image/gif", &format!("\n {} \n", b64(b"gif")))
        .is_ok());
}

#[test]
fn load_rechecks_files_changed_on_disk_and_missing_ones() {
    let data = TempDir::new("att_recheck");
    let store = AttachmentStore::open(data.path(), &[]);
    let info = store.add("tab_1", "image/png", &b64(b"small")).unwrap();
    let file = data
        .join("attachments")
        .join("tab_1")
        .join(format!("{}.png", info.id));
    std::fs::write(&file, vec![0u8; MAX_IMAGE_BYTES + 1]).unwrap();
    assert!(store.load("tab_1", std::slice::from_ref(&info.id)).is_err());
    std::fs::write(&file, b"").unwrap();
    assert!(store.load("tab_1", std::slice::from_ref(&info.id)).is_err());
    std::fs::remove_file(&file).unwrap();
    let err = store.load("tab_1", std::slice::from_ref(&info.id)).unwrap_err();
    assert!(err.contains("gone"), "{err}");
    // Removing an id that is already gone is not an error.
    store.remove("tab_1", &info.id).unwrap();
    assert!(store.load("tab_1", &[]).unwrap().is_empty());
}

#[test]
fn ids_are_unique_and_remove_many_is_best_effort() {
    let data = TempDir::new("att_unique");
    let store = AttachmentStore::open(data.path(), &[]);
    let ids: Vec<String> = (0..200)
        .map(|_| store.add("tab_1", "image/png", &b64(b"x")).unwrap().id)
        .collect();
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());
    let mut doomed = ids[..3].to_vec();
    doomed.push("../evil".into());
    store.remove_many("tab_1", &doomed);
    assert_eq!(names_in(&data.join("attachments").join("tab_1")).len(), 197);
}

#[cfg(unix)]
#[test]
fn startup_prune_removes_a_symlinked_tab_folder_but_not_its_target() {
    let data = TempDir::new("att_prune_link");
    let outside = TempDir::new("att_prune_outside");
    std::fs::write(outside.join("keep.png"), b"keep").unwrap();
    let root = data.join("attachments");
    std::fs::create_dir_all(root.join("tab_live")).unwrap();
    std::fs::create_dir_all(root.join("tab_gone")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("tab_link")).unwrap();
    std::fs::write(root.join("stray.txt"), b"file, not a tab folder").unwrap();

    AttachmentStore::open(data.path(), &["tab_live".to_string()]);
    assert_eq!(names_in(&root), vec!["stray.txt", "tab_live"]);
    assert_eq!(std::fs::read(outside.join("keep.png")).unwrap(), b"keep");
}
