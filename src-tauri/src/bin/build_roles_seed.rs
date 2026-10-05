use dcterminal_lib::roles::RolesFile;
use dcterminal_lib::store::{docs_roles_dir, seed_output_path, write_seed_file};
use dcterminal_lib::template::{all_role_specs, build_role_from_markdown};
use std::fs;

fn main() {
    let docs = docs_roles_dir();
    let mut roles = Vec::new();
    for spec in all_role_specs() {
        let path = docs.join(spec.source_file);
        let markdown = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("read {}: {}", path.display(), e);
        });
        roles.push(build_role_from_markdown(&spec, &markdown));
    }
    let file = RolesFile {
        schema_version: 1,
        roles,
    };
    let out = seed_output_path();
    write_seed_file(&out, &file).unwrap_or_else(|e| panic!("write seed: {e}"));
    println!("Wrote {} ({} roles)", out.display(), file.roles.len());
}
