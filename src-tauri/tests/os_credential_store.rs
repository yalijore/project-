//! Round-trips a secret through the real OS credential store: Windows Credential Manager,
//! macOS Keychain, or the Secret Service on Linux. It lives in its own test binary so no
//! other test can switch this process to the E2E file store via environment variables.
//!
//! Always runs on Windows. Elsewhere it needs an unlocked keychain/keyring, so it runs only
//! with KEEL_TEST_OS_STORE=1.

use keel_lib::secrets::{delete, load, save, StoredSecret};

#[test]
fn os_credential_store_round_trip() {
    if !cfg!(windows) && std::env::var_os("KEEL_TEST_OS_STORE").is_none() {
        eprintln!("skipped: set KEEL_TEST_OS_STORE=1 to test the OS credential store here");
        return;
    }
    assert!(
        std::env::var_os("KEEL_E2E_SECRET_DIR").is_none(),
        "the E2E file store must not be active for this test"
    );
    let id = format!("test-{}", std::process::id());
    let s = StoredSecret {
        provider: "todoist".into(),
        api_token: Some("secret-value".into()),
        ..Default::default()
    };
    save(&id, &s).expect("save to OS credential store");
    assert_eq!(load(&id).unwrap(), Some(s));
    delete(&id).unwrap();
    assert_eq!(load(&id).unwrap(), None);
    delete(&id).expect("deleting a missing entry is not an error");
}
