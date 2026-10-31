//! Concurrency and buffer budget for kiro-sidecar.
//!
//! `ResourceBudget` uses atomics (no locks) to track in-flight request count
//! and total buffered bytes. A `ResourceGuard` RAII handle ensures counters
//! are decremented when a request completes or is dropped.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Reason a resource acquisition was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BusyReason {
    /// The maximum number of concurrent in-flight requests has been reached.
    TooManyRequests,
    /// The total buffered bytes budget has been exhausted.
    BufferFull,
}

/// Atomic budget tracker for concurrency and memory limits.
///
/// All operations are lock-free, using `Ordering::Relaxed` which is sufficient
/// for counters that don't need to synchronise other memory accesses.
pub struct ResourceBudget {
    inflight: AtomicUsize,
    max_inflight: usize,
    buffer_bytes: AtomicUsize,
    max_buffer_bytes: usize,
}

impl std::fmt::Debug for ResourceBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResourceBudget")
            .field("inflight", &self.inflight.load(Ordering::Relaxed))
            .field("max_inflight", &self.max_inflight)
            .field("buffer_bytes", &self.buffer_bytes.load(Ordering::Relaxed))
            .field("max_buffer_bytes", &self.max_buffer_bytes)
            .finish()
    }
}

impl ResourceBudget {
    /// Create a new budget wrapped in an `Arc`.
    pub fn new(max_inflight: usize, max_buffer_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            inflight: AtomicUsize::new(0),
            max_inflight,
            buffer_bytes: AtomicUsize::new(0),
            max_buffer_bytes,
        })
    }

    /// Try to acquire budget for one request with `body_bytes` of buffer.
    ///
    /// On success, returns a `ResourceGuard` that releases the budget on drop.
    /// On failure, returns the `BusyReason` — no resources are consumed.
    pub fn try_acquire(self: &Arc<Self>, body_bytes: usize) -> Result<ResourceGuard, BusyReason> {
        // Step 1: Atomically increment inflight, check against max.
        self.inflight
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current
                    .checked_add(1)
                    .filter(|next| *next <= self.max_inflight)
            })
            .map_err(|_| BusyReason::TooManyRequests)?;

        // Step 2: Atomically add body_bytes to buffer_bytes, check against max.
        if self
            .buffer_bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current
                    .checked_add(body_bytes)
                    .filter(|next| *next <= self.max_buffer_bytes)
            })
            .is_err()
        {
            self.inflight.fetch_sub(1, Ordering::Relaxed);
            return Err(BusyReason::BufferFull);
        }

        Ok(ResourceGuard {
            budget: Arc::clone(self),
            body_bytes,
        })
    }

    /// Current number of in-flight requests (for observability).
    pub fn inflight_count(&self) -> usize {
        self.inflight.load(Ordering::Relaxed)
    }

    /// Current total buffered bytes (for observability).
    pub fn buffer_bytes_used(&self) -> usize {
        self.buffer_bytes.load(Ordering::Relaxed)
    }
}

/// RAII guard that releases budget when dropped.
pub struct ResourceGuard {
    budget: Arc<ResourceBudget>,
    body_bytes: usize,
}

impl std::fmt::Debug for ResourceGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResourceGuard")
            .field("body_bytes", &self.body_bytes)
            .finish()
    }
}

impl ResourceGuard {
    /// Release request-body memory once reqwest has finished sending it. The
    /// in-flight slot remains owned by the downstream response body.
    pub fn release_buffer(&mut self) {
        self.budget
            .buffer_bytes
            .fetch_sub(std::mem::take(&mut self.body_bytes), Ordering::Relaxed);
    }
}

impl Drop for ResourceGuard {
    fn drop(&mut self) {
        self.budget.inflight.fetch_sub(1, Ordering::Relaxed);
        self.budget
            .buffer_bytes
            .fetch_sub(self.body_bytes, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_succeeds_within_budget() {
        let budget = ResourceBudget::new(4, 1024);
        let guard = budget.try_acquire(256).unwrap();

        assert_eq!(budget.inflight_count(), 1);
        assert_eq!(budget.buffer_bytes_used(), 256);

        drop(guard);
        assert_eq!(budget.inflight_count(), 0);
        assert_eq!(budget.buffer_bytes_used(), 0);
    }

    #[test]
    fn acquire_fails_when_inflight_maxed() {
        let budget = ResourceBudget::new(2, 1024);

        let _g1 = budget.try_acquire(100).unwrap();
        let _g2 = budget.try_acquire(100).unwrap();
        assert_eq!(budget.inflight_count(), 2);

        let err = budget.try_acquire(100).unwrap_err();
        assert_eq!(err, BusyReason::TooManyRequests);

        // Counters should not have changed from the failed attempt.
        assert_eq!(budget.inflight_count(), 2);
        assert_eq!(budget.buffer_bytes_used(), 200);
    }

    #[test]
    fn acquire_fails_when_buffer_full() {
        let budget = ResourceBudget::new(100, 500);

        let _g1 = budget.try_acquire(300).unwrap();
        let _g2 = budget.try_acquire(200).unwrap();
        assert_eq!(budget.buffer_bytes_used(), 500);

        // This should fail: 500 + 1 > 500.
        let err = budget.try_acquire(1).unwrap_err();
        assert_eq!(err, BusyReason::BufferFull);

        // Inflight should not have leaked.
        assert_eq!(budget.inflight_count(), 2);
        assert_eq!(budget.buffer_bytes_used(), 500);
    }

    #[test]
    fn guard_drop_releases_budget() {
        let budget = ResourceBudget::new(4, 1024);

        let g1 = budget.try_acquire(256).unwrap();
        let g2 = budget.try_acquire(512).unwrap();
        assert_eq!(budget.inflight_count(), 2);
        assert_eq!(budget.buffer_bytes_used(), 768);

        drop(g1);
        assert_eq!(budget.inflight_count(), 1);
        assert_eq!(budget.buffer_bytes_used(), 512);

        drop(g2);
        assert_eq!(budget.inflight_count(), 0);
        assert_eq!(budget.buffer_bytes_used(), 0);
    }

    #[test]
    fn zero_byte_acquire_succeeds() {
        let budget = ResourceBudget::new(4, 1024);
        let guard = budget.try_acquire(0).unwrap();
        assert_eq!(budget.inflight_count(), 1);
        assert_eq!(budget.buffer_bytes_used(), 0);
        drop(guard);
    }

    #[test]
    fn releasing_buffer_retains_slot_and_is_idempotent() {
        let budget = ResourceBudget::new(1, 256);
        let mut guard = budget.try_acquire(256).unwrap();
        guard.release_buffer();
        guard.release_buffer();
        assert_eq!(budget.buffer_bytes_used(), 0);
        assert_eq!(budget.inflight_count(), 1);
        assert_eq!(
            budget.try_acquire(0).unwrap_err(),
            BusyReason::TooManyRequests
        );
        drop(guard);
        assert_eq!(budget.inflight_count(), 0);
        assert_eq!(budget.buffer_bytes_used(), 0);
    }

    #[test]
    fn buffer_reservation_cannot_overflow() {
        let budget = ResourceBudget::new(2, usize::MAX);
        let _guard = budget.try_acquire(usize::MAX).unwrap();
        assert_eq!(budget.try_acquire(1).unwrap_err(), BusyReason::BufferFull);
        assert_eq!(budget.inflight_count(), 1);
        assert_eq!(budget.buffer_bytes_used(), usize::MAX);
    }
}
