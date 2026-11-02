package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/http2"
)

func TestKiroRelayPreservesUpstreamErrorAndStripsControlHeaders(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, name := range []string{"X-Kiro-Protocol-Version", "X-Kiro-Sidecar-Token", "X-Target-Url", "X-Proxy-Url", "Proxy-Authorization", "X-Remove"} {
			if r.Header.Get(name) != "" {
				t.Errorf("local header %s reached upstream", name)
			}
		}
		if r.Header.Get("Authorization") != "Bearer test" {
			t.Error("business authorization was lost")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"message":"hello"}` {
			t.Errorf("request body changed: %s", body)
		}
		w.Header().Set("X-Kiro-Response-Source", "sidecar")
		w.Header().Set("X-Kiro-Protocol-Version", "spoofed")
		w.Header().Set("X-Kiro-Error-Code", "TLS_ERROR")
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, "exact upstream error")
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	// Inject the TLS fixture's trusted transport; production uses uTLS.
	rtCacheMu.Lock()
	previous := rtCache[""]
	rtCache[""] = newUTLSRoundTripper("")
	rtCache[""].h1Transports[u.Host] = upstream.Client().Transport.(*http.Transport)
	rtCacheMu.Unlock()
	defer func() {
		rtCacheMu.Lock()
		if previous == nil {
			delete(rtCache, "")
		} else {
			rtCache[""] = previous
		}
		rtCacheMu.Unlock()
	}()
	r := httptest.NewRequest(http.MethodPost, "/kiro/stream", strings.NewReader(`{"message":"hello"}`))
	r.Header.Set("X-Kiro-Protocol-Version", "1")
	r.Header.Set("X-Kiro-Sidecar-Token", "local-secret")
	r.Header.Set("X-Target-Url", upstream.URL)
	r.Header.Set("Authorization", "Bearer test")
	r.Header.Set("Proxy-Authorization", "local-proxy-secret")
	r.Header.Set("Connection", "X-Remove")
	r.Header.Set("X-Remove", "hop-only")
	w := httptest.NewRecorder()
	handleKiroProxy(w, r)
	if w.Code != http.StatusForbidden || w.Body.String() != "exact upstream error" {
		t.Fatalf("upstream response changed: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Kiro-Response-Source") != "upstream" || w.Header().Get("X-Kiro-Protocol-Version") != "1" || w.Header().Get("X-Kiro-Error-Code") != "" {
		t.Fatalf("relay source was spoofed: %v", w.Header())
	}
	if w.Header().Get("Retry-After") != "7" {
		t.Error("retry-after was lost")
	}
}

func TestKiroRelayRejectsMalformedRequestsLocally(t *testing.T) {
	for _, target := range []string{"", "http://example.com", "https://user:secret@example.com", "https://example.com/#fragment"} {
		r := httptest.NewRequest(http.MethodPost, "/kiro/stream", strings.NewReader("{}"))
		r.Header.Set("X-Kiro-Protocol-Version", "1")
		r.Header.Set("X-Target-Url", target)
		w := httptest.NewRecorder()
		handleKiroProxy(w, r)
		if w.Code != http.StatusBadRequest || w.Header().Get("X-Kiro-Response-Source") != "sidecar" || w.Header().Get("X-Kiro-Error-Code") != "INVALID_TARGET" {
			t.Fatalf("expected local validation error for %q: %d %v", target, w.Code, w.Header())
		}
		if strings.Contains(w.Body.String(), "secret") {
			t.Fatal("credentials leaked in response")
		}
	}
}

func TestProxyAuthenticationUsesStatusInsteadOfPortDigits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusProxyAuthRequired)
	}))
	defer server.Close()
	_, err := dialViaProxy(context.Background(), "tcp", "upstream.invalid:443", server.URL)
	if err == nil || classifyProxyError(err, true) != "PROXY_AUTH_FAILED" {
		t.Fatalf("407 was not classified as authentication failure: %v", err)
	}
	if code := classifyProxyError(fmt.Errorf("dial tcp 127.0.0.1:4077: connection refused"), true); code != "PROXY_CONNECT_ERROR" {
		t.Fatalf("proxy port digits were mistaken for HTTP status: %s", code)
	}
}

func TestCacheCleanupDoesNotInterruptAnActiveResponse(t *testing.T) {
	for _, protocol := range []string{"h1", "h2"} {
		for _, cleanup := range []string{"all", "lru"} {
			t.Run(protocol+"/"+cleanup, func(t *testing.T) {
				testActiveResponseCleanup(t, protocol, cleanup)
			})
		}
	}
}

func testActiveResponseCleanup(t *testing.T, protocol, cleanup string) {
	t.Helper()
	release := make(chan struct{})
	var once sync.Once
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "first")
		w.(http.Flusher).Flush()
		<-release
		io.WriteString(w, "second")
	}))
	upstream.EnableHTTP2 = protocol == "h2"
	upstream.StartTLS()
	defer func() { once.Do(func() { close(release) }); upstream.Close() }()
	address := upstream.Listener.Addr().String()
	rt := newUTLSRoundTripper("")
	if protocol == "h2" {
		roots := x509.NewCertPool()
		roots.AddCert(upstream.Certificate())
		conn, err := tls.Dial("tcp", address, &tls.Config{RootCAs: roots, NextProtos: []string{"h2"}})
		if err != nil {
			t.Fatal(err)
		}
		transport := &http2.Transport{}
		cc, err := transport.NewClientConn(conn)
		if err != nil {
			conn.Close()
			t.Fatal(err)
		}
		defer cc.Close()
		rt.h2Conns[address] = cc
	} else {
		rt.h1Transports[address] = upstream.Client().Transport.(*http.Transport)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, upstream.URL, nil)
	response, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	first := make([]byte, 5)
	if _, err := io.ReadFull(response.Body, first); err != nil {
		t.Fatal(err)
	}
	if cleanup == "all" {
		rt.CloseIdleConnections()
	} else {
		rt.mu.Lock()
		for i := 0; i < maxCachedOrigins; i++ {
			addr := fmt.Sprintf("cache-%d.invalid:443", i)
			rt.h1Transports[addr] = &http.Transport{}
			rt.touchOriginLocked(addr)
		}
		rt.mu.Unlock()
	}
	if rt.h1Transports[address] != nil || rt.h2Conns[address] != nil {
		t.Fatal("active origin was not evicted from the cache")
	}
	once.Do(func() { close(release) })
	rest, err := io.ReadAll(response.Body)
	if err != nil || string(first)+string(rest) != "firstsecond" {
		t.Fatalf("cleanup truncated active response: %q %q %v", first, rest, err)
	}
}

func TestOriginCacheEvictsTheLeastRecentlyUsedTransport(t *testing.T) {
	rt := newUTLSRoundTripper("")
	rt.mu.Lock()
	for i := 0; i < maxCachedOrigins; i++ {
		addr := fmt.Sprintf("cache-%d.invalid:443", i)
		rt.h1Transports[addr] = &http.Transport{}
		rt.touchOriginLocked(addr)
		rt.originLastUsed[addr] = time.Unix(int64(i), 0)
	}
	// A frequently reused origin must survive even when it was inserted first.
	rt.touchOriginLocked("cache-0.invalid:443")
	rt.h1Transports["new.invalid:443"] = &http.Transport{}
	rt.touchOriginLocked("new.invalid:443")
	rt.mu.Unlock()
	if rt.h1Transports["cache-1.invalid:443"] != nil || rt.h1Transports["cache-0.invalid:443"] == nil || rt.h1Transports["new.invalid:443"] == nil {
		t.Fatal("cache did not evict the least recently used origin")
	}
	if len(rt.h1Transports)+len(rt.h2Conns) != maxCachedOrigins || len(rt.originLastUsed) != maxCachedOrigins {
		t.Fatal("origin cache exceeded its capacity")
	}
	rt.CloseIdleConnections()
	if len(rt.h1Transports)+len(rt.h2Conns)+len(rt.originLastUsed) != 0 {
		t.Fatal("cleanup retained origin cache entries")
	}
}

func TestDialLocksAreReleasedAfterEachOrigin(t *testing.T) {
	rt := newUTLSRoundTripper("")
	for i := 0; i < maxCachedOrigins*2; i++ {
		release, err := rt.acquireDialLock(context.Background(), fmt.Sprintf("origin-%d.invalid:443", i))
		if err != nil {
			t.Fatal(err)
		}
		release()
		release() // Early release plus deferred release must be safe.
	}
	if len(rt.dialLocks) != 0 {
		t.Fatal("completed origins retained dial locks")
	}
}

func TestCancelledDialWaiterDoesNotSplitTheOriginLock(t *testing.T) {
	rt := newUTLSRoundTripper("")
	first, err := rt.acquireDialLock(context.Background(), "same.invalid:443")
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := rt.acquireDialLock(cancelled, "same.invalid:443"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancelled waiter, got %v", err)
	}
	acquired := make(chan error, 1)
	ctx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	go func() {
		release, err := rt.acquireDialLock(ctx, "same.invalid:443")
		if err == nil {
			release()
		}
		acquired <- err
	}()
	select {
	case err := <-acquired:
		t.Fatalf("waiter bypassed the current initializer: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	first()
	if err := <-acquired; err != nil {
		t.Fatal(err)
	}
	if len(rt.dialLocks) != 0 {
		t.Fatal("cancelled or completed waiters retained the origin lock")
	}
}
