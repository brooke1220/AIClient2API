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
        let prev_inflight = self.inflight.fetch_add(1, Ordering::Relaxed);
        if prev_inflight >= self.max_inflight {
            // Roll back.
            self.inflight.fetch_sub(1, Ordering::Relaxed);
            return Err(BusyReason::TooManyRequests);
        }

        // Step 2: Atomically add body_bytes to buffer_bytes, check against max.
        let prev_bytes = self.buffer_bytes.fetch_add(body_bytes, Ordering::Relaxed);
        if prev_bytes + body_bytes > self.max_buffer_bytes {
            // Roll back both counters.
            self.buffer_bytes.fetch_sub(body_bytes, Ordering::Relaxed);
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
}
