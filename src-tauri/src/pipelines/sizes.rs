//! F3: run sizes. Each size starts one built-in pipeline and adds no engine
//! logic: S is Eagle-Eye 2, M is Eagle-Eye 1, L is Eagle-Eye L. The start
//! screen suggests one (`src/pipeline/sizes.ts`) and you can pick another;
//! the run keeps the size it started with (`PipelineRun::size`) for the
//! overview.

/// Each size and the pipeline id it starts (as `SIZE_PIPELINE` in the frontend).
pub const SIZES: [(&str, &str); 3] = [("S", "eagle2"), ("M", "eagle1"), ("L", "eagle-eye-l")];

/// The size a pipeline (id or run kind) is, if it is one of the sized built-ins.
pub fn size_of_pipeline(kind: &str) -> Option<&'static str> {
    let def = super::find(kind)?;
    SIZES.iter().find(|(_, id)| *id == def.id).map(|(size, _)| *size)
}

/// The size a start asked for, kept only when it is the size of the pipeline
/// the start begins (`kind`): a size never disagrees with its run's pipeline.
pub fn checked_size(size: Option<&str>, kind: &str) -> Option<&'static str> {
    let wanted = size?.trim();
    size_of_pipeline(kind).filter(|size| size.eq_ignore_ascii_case(wanted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_size_starts_one_built_in_pipeline() {
        assert_eq!(size_of_pipeline("eagle2"), Some("S"));
        assert_eq!(size_of_pipeline("execute"), Some("S"), "by run kind too");
        assert_eq!(size_of_pipeline("eagle1"), Some("M"));
        assert_eq!(size_of_pipeline("full"), Some("M"));
        assert_eq!(size_of_pipeline("eagle-eye-l"), Some("L"));
        assert_eq!(size_of_pipeline("mystery"), None);
        for (_, id) in SIZES {
            assert!(super::super::find(id).is_some_and(|def| def.built_in), "{id}");
        }
    }

    #[test]
    fn a_size_is_kept_only_when_it_matches_the_pipeline() {
        assert_eq!(checked_size(Some("L"), "eagle-eye-l"), Some("L"));
        assert_eq!(checked_size(Some(" m "), "eagle1"), Some("M"));
        assert_eq!(checked_size(Some("S"), "eagle1"), None);
        assert_eq!(checked_size(Some("XL"), "eagle1"), None);
        assert_eq!(checked_size(None, "eagle1"), None);
    }
}
