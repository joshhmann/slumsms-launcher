//! Deferred single-instance registration after an updated child's health handshake.

use crate::{Error, Result};
use std::time::Duration;

/// The old launcher cannot exit until the child reports healthy. Once it has, wait
/// for ownership to disappear before registering; registering while another owner
/// exists would forward to the old process and terminate the healthy child.
pub async fn reacquire(mut owner_present: impl FnMut() -> Result<bool>, register: impl FnOnce() -> Result<()>, timeout: Duration) -> Result<()> {
    tokio::time::timeout(timeout, async {
        while owner_present()? {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        register()
    })
    .await
    .map_err(|_| Error::new("The previous launcher did not release single-instance ownership in time."))?
}

/// Unix development builds use the updater's PID rather than a desktop bus.
#[cfg(unix)]
pub fn parent_present(pid: u32) -> Result<bool> {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let pid = i32::try_from(pid)
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| Error::new("Invalid update parent PID."))?;
    // SAFETY: signal zero only checks whether a process exists; it sends no signal.
    if unsafe { kill(pid, 0) } == 0 {
        return Ok(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(3) => Ok(false), // ESRCH
        Some(1) => Ok(true),  // EPERM
        _ => Err(Error::new("Could not check the previous launcher process.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn updated_child_reacquires_ownership_and_later_launches_are_secondary() {
        let owned = Arc::new(AtomicBool::new(true));
        let registrations = Arc::new(AtomicUsize::new(0));
        let parent = owned.clone();
        let count = registrations.clone();
        let child = tokio::spawn(async move {
            reacquire(
                || Ok(owned.load(Ordering::SeqCst)),
                || {
                    assert!(!owned.swap(true, Ordering::SeqCst));
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                Duration::from_secs(2),
            )
            .await
            .unwrap();
            owned
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(registrations.load(Ordering::SeqCst), 0, "allow the health handshake before registration");
        parent.store(false, Ordering::SeqCst);
        let owned = child.await.unwrap();
        assert_eq!(registrations.load(Ordering::SeqCst), 1);
        assert!(owned.swap(true, Ordering::SeqCst), "a later launch finds the child owns the instance");
    }

    #[tokio::test]
    async fn a_stuck_parent_never_leaves_an_unregistered_full_instance() {
        let error = reacquire(|| Ok(true), || panic!("must not register while parent owns it"), Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.message.contains("single-instance ownership"));
    }
}
