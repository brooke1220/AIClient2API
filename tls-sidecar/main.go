package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

// ──────────────────────────────────────────────
// TLS Sidecar — Go uTLS reverse proxy
//
// Node.js 发请求到 http://127.0.0.1:<port>，
// 通过以下自定义 Header 传递目标信息：
//   X-Target-Url:   实际目标 URL（必填）
//   X-Proxy-Url:    上游代理（可选，支持 http/https/socks5）
//
// 所有其他 Header 原样转发给目标服务器。
// 响应（包括 SSE 流式）透传回 Node.js。
//
// uTLS 使用 Chrome 最新指纹，ALPN 协商 h2/http1.1，
// 根据服务器返回的 ALPN 自动选择 HTTP/2 或 HTTP/1.1 传输。
// ──────────────────────────────────────────────

const (
	defaultPort      = 9090
	headerTarget     = "X-Target-Url"
	headerProxy      = "X-Proxy-Url"
	readTimeout      = 30 * time.Second
	writeTimeout     = 0 // SSE 流式响应不设写超时（仅监听 localhost，安全）
	idleTimeout      = 120 * time.Second
	maxCachedOrigins = 128 // Per proxy; eviction never interrupts an active response.
)

// 全局 RoundTripper 缓存（按 proxyURL 分组，复用 H2 连接）
var (
	rtCacheMu sync.Mutex
	rtCache   = make(map[string]*utlsRoundTripper)
)

func getOrCreateRT(proxyURL string) *utlsRoundTripper {
	rtCacheMu.Lock()
	defer rtCacheMu.Unlock()
	if rt, ok := rtCache[proxyURL]; ok {
		return rt
	}
	rt := newUTLSRoundTripper(proxyURL)
	rtCache[proxyURL] = rt
	return rt
}

// ──────────────── uTLS RoundTripper ────────────────
// 根据 ALPN 协商结果自动选择 H2 或 H1 传输

type utlsRoundTripper struct {
	proxyURL string
	lastUsed time.Time // 最后使用时间，用于缓存清理

	mu             sync.Mutex
	h2Conns        map[string]*http2.ClientConn // H2 连接缓存 (per host)
	h1Transports   map[string]*http.Transport
	originLastUsed map[string]time.Time
	dialLocks      map[string]*originDialLock
}

type originDialLock struct {
	gate chan struct{}
	refs int // Includes the current initializer and every waiting request.
}

func newUTLSRoundTripper(proxyURL string) *utlsRoundTripper {
	return &utlsRoundTripper{
		proxyURL:       proxyURL,
		lastUsed:       time.Now(),
		h2Conns:        make(map[string]*http2.ClientConn),
		h1Transports:   make(map[string]*http.Transport),
		originLastUsed: make(map[string]time.Time),
		dialLocks:      make(map[string]*originDialLock),
	}
}

func (rt *utlsRoundTripper) acquireDialLock(ctx context.Context, addr string) (func(), error) {
	rt.mu.Lock()
	lock := rt.dialLocks[addr]
	if lock == nil {
		lock = &originDialLock{gate: make(chan struct{}, 1)}
		rt.dialLocks[addr] = lock
	}
	lock.refs++
	rt.mu.Unlock()

	releaseRef := func() {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		lock.refs--
		if lock.refs == 0 {
			delete(rt.dialLocks, addr)
		}
	}
	select {
	case lock.gate <- struct{}{}:
		var once sync.Once
		return func() {
			once.Do(func() {
				<-lock.gate
				releaseRef()
			})
		}, nil
	case <-ctx.Done():
		releaseRef()
		return nil, ctx.Err()
	}
}

// Caller holds rt.mu. Active requests retain their transport/connection even
// after eviction; idle resources close now and active H2 streams drain first.
func (rt *utlsRoundTripper) removeOriginLocked(addr string) {
	if cc := rt.h2Conns[addr]; cc != nil {
		cc.SetDoNotReuse()
		if cc.State().StreamsActive == 0 {
			cc.Close()
		}
		delete(rt.h2Conns, addr)
	}
	if transport := rt.h1Transports[addr]; transport != nil {
		transport.CloseIdleConnections()
		delete(rt.h1Transports, addr)
	}
	delete(rt.originLastUsed, addr)
}

func (rt *utlsRoundTripper) touchOriginLocked(addr string) {
	rt.originLastUsed[addr] = time.Now()
	if len(rt.originLastUsed) <= maxCachedOrigins {
		return
	}
	var oldest string
	var oldestTime time.Time
	for candidate, used := range rt.originLastUsed {
		if candidate != addr && (oldest == "" || used.Before(oldestTime)) {
			oldest, oldestTime = candidate, used
		}
	}
	rt.removeOriginLocked(oldest)
}

func (rt *utlsRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.mu.Lock()
	rt.lastUsed = time.Now()
	rt.mu.Unlock()

	port := req.URL.Port()
	if port == "" {
		if req.URL.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	addr := net.JoinHostPort(req.URL.Hostname(), port)

	// Serialize connection initialization per origin, not per proxy or request.
	releaseDialLock, err := rt.acquireDialLock(req.Context(), addr)
	if err != nil {
		return nil, err
	}
	defer releaseDialLock()

	rt.mu.Lock()
	if transport := rt.h1Transports[addr]; transport != nil {
		rt.touchOriginLocked(addr)
		rt.mu.Unlock()
		releaseDialLock()
		return transport.RoundTrip(req)
	}
	if cc, ok := rt.h2Conns[addr]; ok {
		rt.touchOriginLocked(addr)
		rt.mu.Unlock()
		if cc.CanTakeNewRequest() {
			releaseDialLock()
			resp, err := cc.RoundTrip(req)
			// Node owns retries. An error does not prove the upstream did not execute.
			if err != nil {
				rt.mu.Lock()
				if rt.h2Conns[addr] == cc {
					delete(rt.h2Conns, addr)
					delete(rt.originLastUsed, addr)
				}
				rt.mu.Unlock()
				cc.SetDoNotReuse()
				if cc.State().StreamsActive == 0 {
					cc.Close()
				}
			}
			return resp, err
		}
		rt.mu.Lock()
		delete(rt.h2Conns, addr)
		delete(rt.originLastUsed, addr)
		rt.mu.Unlock()
		cc.SetDoNotReuse()
		if cc.State().StreamsActive == 0 {
			cc.Close()
		}
	} else {
		rt.mu.Unlock()
	}

	// 建立新的 uTLS 连接
	conn, err := dialUTLS(req.Context(), "tcp", addr, rt.proxyURL)
	if err != nil {
		return nil, err
	}

	// 根据 ALPN 协商结果决定走 H2 还是 H1
	alpn := conn.ConnectionState().NegotiatedProtocol
	log.Printf("[TLS-Sidecar] Connected to %s, ALPN: %q", addr, alpn)

	if alpn == "h2" {
		// HTTP/2: 创建 H2 ClientConn
		t2 := &http2.Transport{
			StrictMaxConcurrentStreams: true,
			AllowHTTP:                  false,
			DisableCompression:         true,
		}
		cc, err := t2.NewClientConn(conn)
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("h2 client conn: %w", err)
		}

		rt.mu.Lock()
		rt.h2Conns[addr] = cc
		rt.touchOriginLocked(addr)
		rt.mu.Unlock()

		releaseDialLock()
		return cc.RoundTrip(req)
	}

	// Persist the H1 transport too, so requests reuse the established connection.
	var first sync.Once
	t1 := &http.Transport{
		DialTLSContext: func(ctx context.Context, network, a string) (net.Conn, error) {
			var initial net.Conn
			first.Do(func() { initial = conn })
			if initial != nil {
				return initial, nil
			}
			return dialUTLSWithProtocols(ctx, network, a, rt.proxyURL, []string{"http/1.1"})
		},
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	}
	rt.mu.Lock()
	rt.h1Transports[addr] = t1
	rt.touchOriginLocked(addr)
	rt.mu.Unlock()
	releaseDialLock()
	resp, err := t1.RoundTrip(req)
	// A request cancelled before dialing must not strand the seed connection.
	first.Do(func() { conn.Close() })
	return resp, err
}

func (rt *utlsRoundTripper) CloseIdleConnections() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for addr := range rt.h2Conns {
		rt.removeOriginLocked(addr)
	}
	for addr := range rt.h1Transports {
		rt.removeOriginLocked(addr)
	}
}

// ──────────────── Main ────────────────

func main() {
	// 强制将日志输出到 Stdout，避免 Node.js 侧将其误判为 Error
	log.SetOutput(os.Stdout)

	port := defaultPort
	if p := os.Getenv("TLS_SIDECAR_PORT"); p != "" {
		if v, err := strconv.Atoi(p); err == nil {
			port = v
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/kiro/stream", handleKiroProxy)
	mux.HandleFunc("/", handleProxy)

	srv := &http.Server{
		Addr:         fmt.Sprintf("127.0.0.1:%d", port),
		Handler:      mux,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
		IdleTimeout:  idleTimeout,
	}

	// 定期清理长时间未使用的 RoundTripper 缓存，防止无限增长
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			rtCacheMu.Lock()
			now := time.Now()
			for key, rt := range rtCache {
				rt.mu.Lock()
				idle := now.Sub(rt.lastUsed)
				rt.mu.Unlock()
				if idle > 10*time.Minute {
					rt.CloseIdleConnections()
					delete(rtCache, key)
				}
			}
			rtCacheMu.Unlock()
		}
	}()

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("[TLS-Sidecar] Shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	log.Printf("[TLS-Sidecar] Listening on 127.0.0.1:%d (Chrome uTLS, H2+H1 auto)\n", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[TLS-Sidecar] Fatal: %v", err)
	}
}

// ──────────────── Health ────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	fmt.Fprintf(w, `{"status":"ok","tls":"utls-chrome-auto","protocols":"h2,http/1.1","kiro_relay_protocol_version":1,"kiro_relay_requests":%d}`, kiroRelayRequests.Load())
}

// ──────────────── Proxy Handler ────────────────

func handleProxy(w http.ResponseWriter, r *http.Request) {
	proxyRequest(w, r, false)
}

func proxyRequest(w http.ResponseWriter, r *http.Request, kiro bool) {
	targetURL := r.Header.Get(headerTarget)
	if targetURL == "" {
		writeProxyError(w, kiro, http.StatusBadRequest, "INVALID_TARGET", nil)
		return
	}

	proxyURL := r.Header.Get(headerProxy)

	// Parse target
	parsed, err := url.Parse(targetURL)
	if err != nil || parsed.Hostname() == "" || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" {
		writeProxyError(w, kiro, http.StatusBadRequest, "INVALID_TARGET", err)
		return
	}
	if kiro && proxyURL != "" && !validKiroProxy(proxyURL) {
		writeProxyError(w, true, http.StatusBadRequest, "INVALID_PROXY", nil)
		return
	}

	// Build outgoing request
	// The caller owns streaming deadlines; cancellation propagates across this hop.
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		writeProxyError(w, kiro, http.StatusBadRequest, "INVALID_TARGET", err)
		return
	}

	// Copy headers (skip internal + hop-by-hop)
	// 403 关键修复：彻底清理所有非浏览器标头，严格保持小写
	for key, vals := range r.Header {
		lk := strings.ToLower(key)
		if lk == strings.ToLower(headerTarget) || lk == strings.ToLower(headerProxy) ||
			strings.HasPrefix(lk, "x-kiro-") || lk == "proxy-authorization" || lk == "content-length" || connectionHeader(r.Header, lk) {
			continue
		}
		// 移除所有代理、本地网络特征标头，防止 Cloudflare 识别
		if lk == "connection" || lk == "keep-alive" || lk == "transfer-encoding" ||
			lk == "te" || lk == "trailer" || lk == "upgrade" || lk == "host" ||
			lk == "x-forwarded-for" || lk == "x-real-ip" || lk == "x-forwarded-proto" ||
			lk == "x-forwarded-host" || lk == "via" || lk == "proxy-connection" ||
			lk == "cf-connecting-ip" || lk == "true-client-ip" {
			continue
		}
		// 直接通过 map 赋值，确保 Go 的 http2 栈能识别并以原始（小写）形式发出
		copied := make([]string, len(vals))
		copy(copied, vals)
		outReq.Header[key] = copied
	}
	outReq.Host = parsed.Host
	outReq.ContentLength = r.ContentLength

	// 针对 Grok 的特殊处理：如果 Accept-Encoding 包含 br 且环境可能存在压缩协商问题
	// 强制设置为标准的浏览器组合
	if ae := outReq.Header["Accept-Encoding"]; !kiro && len(ae) > 0 {
		outReq.Header["Accept-Encoding"] = []string{"gzip, deflate, br, zstd"}
	}

	// Execute via uTLS RoundTripper
	rt := getOrCreateRT(proxyURL)
	resp, err := rt.RoundTrip(outReq)
	if err != nil {
		code := classifyProxyError(err, proxyURL != "")
		log.Printf("[TLS-Sidecar] RoundTrip error for %s: %s", parsed.Host, code)
		writeProxyError(w, kiro, http.StatusBadGateway, code, err)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for key, vals := range resp.Header {
		if connectionHeader(resp.Header, key) || hopByHopHeader(key) || (kiro && strings.HasPrefix(strings.ToLower(key), "x-kiro-")) {
			continue
		}
		for _, v := range vals {
			w.Header().Add(key, v)
		}
	}
	if kiro {
		w.Header().Set("X-Kiro-Protocol-Version", "1")
		w.Header().Set("X-Kiro-Response-Source", "upstream")
	}
	w.WriteHeader(resp.StatusCode)

	// Stream body (SSE-friendly: flush after every read)
	flusher, canFlush := w.(http.Flusher)
	if kiro && canFlush {
		flusher.Flush()
	}
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				log.Printf("[TLS-Sidecar] Write error: %v", writeErr)
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				log.Printf("[TLS-Sidecar] Read error: %v", readErr)
				// Propagate truncation to Rust/Node instead of a clean chunked EOF.
				panic(http.ErrAbortHandler)
			}
			return
		}
	}
}

// ──────────────── uTLS Dial ────────────────

func dialUTLS(ctx context.Context, network, addr string, proxyURL string) (*utls.UConn, error) {
	return dialUTLSWithProtocols(ctx, network, addr, proxyURL, []string{"h2", "http/1.1"})
}

func dialUTLSWithProtocols(ctx context.Context, network, addr, proxyURL string, protocols []string) (*utls.UConn, error) {
	roots, err := tlsRootCAs()
	if err != nil {
		return nil, err
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}

	// TCP 连接（可能经过代理）
	var rawConn net.Conn
	if proxyURL != "" {
		rawConn, err = dialViaProxy(ctx, network, addr, proxyURL)
	} else {
		var d net.Dialer
		rawConn, err = d.DialContext(ctx, network, addr)
	}
	if err != nil {
		return nil, fmt.Errorf("tcp dial failed: %w", err)
	}

	// uTLS 握手 — 使用 Chrome 最新自动指纹
	// 403 错误通过保持标头小写和清理转发标头来解决
	tlsConn := utls.UClient(rawConn, &utls.Config{
		ServerName: host,
		RootCAs:    roots,
		NextProtos: protocols,
	}, utls.HelloChrome_Auto)
	if len(protocols) == 1 {
		if err := tlsConn.BuildHandshakeState(); err != nil {
			rawConn.Close()
			return nil, err
		}
		// Chrome's preset supplies ALPN itself; override its extension for a
		// persistent H1 transport that must never negotiate H2 on later dials.
		for _, extension := range tlsConn.Extensions {
			if alpn, ok := extension.(*utls.ALPNExtension); ok {
				alpn.AlpnProtocols = protocols
			}
		}
	}

	// 握手超时
	if deadline, ok := ctx.Deadline(); ok {
		tlsConn.SetDeadline(deadline)
	} else {
		tlsConn.SetDeadline(time.Now().Add(15 * time.Second))
	}

	if err := tlsConn.HandshakeContext(ctx); err != nil {
		rawConn.Close()
		return nil, fmt.Errorf("utls handshake failed: %w", err)
	}

	// 握手完成，清除超时
	tlsConn.SetDeadline(time.Time{})
	return tlsConn, nil
}

// ──────────────── Proxy Dialer ────────────────

func dialViaProxy(ctx context.Context, network, addr string, proxyURL string) (net.Conn, error) {
	parsed, err := url.Parse(proxyURL)
	if err != nil || parsed.Hostname() == "" {
		return nil, fmt.Errorf("invalid proxy url")
	}

	switch strings.ToLower(parsed.Scheme) {
	case "socks5", "socks5h":
		var auth *proxy.Auth
		if parsed.User != nil {
			auth = &proxy.Auth{
				User: parsed.User.Username(),
			}
			auth.Password, _ = parsed.User.Password()
		}
		port := parsed.Port()
		if port == "" {
			port = "1080"
		}
		dialer, err := proxy.SOCKS5("tcp", net.JoinHostPort(parsed.Hostname(), port), auth, &net.Dialer{
			Timeout: 15 * time.Second,
		})
		if err != nil {
			return nil, fmt.Errorf("socks5 dialer: %w", err)
		}
		if ctxDialer, ok := dialer.(proxy.ContextDialer); ok {
			return ctxDialer.DialContext(ctx, network, addr)
		}
		return dialer.Dial(network, addr)

	case "http", "https":
		return dialHTTPProxy(ctx, addr, parsed, nil)

	default:
		return nil, fmt.Errorf("unsupported proxy scheme: %s", parsed.Scheme)
	}
}

// Keep any tunnel bytes read together with the CONNECT response headers.
type bufferedProxyConn struct {
	net.Conn
	reader *bufio.Reader
}

func (conn *bufferedProxyConn) Read(p []byte) (int, error) {
	return conn.reader.Read(p)
}

func dialHTTPProxy(ctx context.Context, addr string, parsed *url.URL, tlsConfig *tls.Config) (net.Conn, error) {
	connectCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	port := parsed.Port()
	if port == "" {
		port = "80"
		if strings.EqualFold(parsed.Scheme, "https") {
			port = "443"
		}
	}
	proxyAddr := net.JoinHostPort(parsed.Hostname(), port)
	dialer := &net.Dialer{}
	var conn net.Conn
	var err error
	if strings.EqualFold(parsed.Scheme, "https") {
		if tlsConfig == nil {
			roots, rootsErr := tlsRootCAs()
			if rootsErr != nil {
				return nil, rootsErr
			}
			tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
		} else {
			tlsConfig = tlsConfig.Clone()
		}
		tlsConfig.ServerName = parsed.Hostname()
		tlsDialer := &tls.Dialer{NetDialer: dialer, Config: tlsConfig}
		conn, err = tlsDialer.DialContext(connectCtx, "tcp", proxyAddr)
	} else {
		conn, err = dialer.DialContext(connectCtx, "tcp", proxyAddr)
	}
	if err != nil {
		return nil, fmt.Errorf("connect to proxy: %w", err)
	}
	stopCancellation := context.AfterFunc(connectCtx, func() { conn.Close() })
	defer stopCancellation()
	deadline, _ := connectCtx.Deadline()
	conn.SetDeadline(deadline)

	connectReq := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: addr},
		Host:   addr,
		Header: make(http.Header),
	}
	if parsed.User != nil {
		password, _ := parsed.User.Password()
		credential := base64.StdEncoding.EncodeToString([]byte(parsed.User.Username() + ":" + password))
		connectReq.Header.Set("Proxy-Authorization", "Basic "+credential)
	}
	if err = connectReq.Write(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("proxy CONNECT write: %w", err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, connectReq)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("invalid proxy CONNECT response")
	}
	if response.StatusCode != http.StatusOK {
		conn.Close()
		return nil, &proxyStatusError{status: response.StatusCode}
	}
	conn.SetDeadline(time.Time{})
	return &bufferedProxyConn{Conn: conn, reader: reader}, nil
}
