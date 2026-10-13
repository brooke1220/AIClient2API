package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestProxyConnectAuthenticationAndBufferedResponse(t *testing.T) {
	for _, secure := range []bool{false, true} {
		name := "http"
		if secure {
			name = "https"
		}
		t.Run(name, func(t *testing.T) {
			requests := make(chan *http.Request, 1)
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests <- r
				conn, buffer, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer conn.Close()
				// A split response header followed by tunnel data must be preserved.
				buffer.WriteString("HTTP/1.1 200 Connection")
				buffer.Flush()
				buffer.WriteString(" established\r\nX-Test: proxy\r\n\r\nhello")
				buffer.Flush()
			})
			server := httptest.NewUnstartedServer(handler)
			if secure {
				server.StartTLS()
			} else {
				server.Start()
			}
			defer server.Close()
			parsed, _ := url.Parse(server.URL)
			parsed.User = url.UserPassword("proxy-user", "proxy:password")
			var conn net.Conn
			var err error
			if secure {
				roots := x509.NewCertPool()
				roots.AddCert(server.Certificate())
				conn, err = dialHTTPProxy(context.Background(), "upstream.invalid:443", parsed, &tls.Config{RootCAs: roots})
			} else {
				conn, err = dialViaProxy(context.Background(), "tcp", "upstream.invalid:443", parsed.String())
			}
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			body := make([]byte, 5)
			if _, err := io.ReadFull(conn, body); err != nil || string(body) != "hello" {
				t.Fatalf("buffered tunnel bytes = %q, err = %v", body, err)
			}
			request := <-requests
			if request.Method != http.MethodConnect || request.Host != "upstream.invalid:443" {
				t.Fatalf("unexpected CONNECT request: %s %s", request.Method, request.Host)
			}
			expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("proxy-user:proxy:password"))
			if request.Header.Get("Proxy-Authorization") != expected {
				t.Fatal("proxy credentials were not sent as Basic authentication")
			}
			if (request.TLS != nil) != secure {
				t.Fatal("HTTPS proxy connection did not use TLS")
			}
		})
	}
}

func TestProxyConnectRejectsNonSuccessEvenWhenHeaderContains200(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Not-A-Status", "200")
		w.WriteHeader(http.StatusProxyAuthRequired)
		io.WriteString(w, "must-not-appear-in-error")
	}))
	defer server.Close()
	conn, err := dialViaProxy(context.Background(), "tcp", "upstream.invalid:443", server.URL)
	if conn != nil || err == nil || !strings.Contains(err.Error(), "407") {
		t.Fatalf("expected CONNECT rejection, got conn=%v err=%v", conn, err)
	}
	if strings.Contains(err.Error(), "must-not-appear") {
		t.Fatal("upstream response body leaked into the error")
	}
}

func TestHTTPSProxyVerifiesCertificate(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("untrusted HTTPS proxy should be rejected before CONNECT")
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	defer server.Close()
	conn, err := dialViaProxy(context.Background(), "tcp", "upstream.invalid:443", server.URL)
	if conn != nil || err == nil {
		t.Fatal("expected certificate validation failure")
	}
}

func TestProxyConnectHonorsCancellation(t *testing.T) {
	received := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(received)
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := dialViaProxy(ctx, "tcp", "upstream.invalid:443", server.URL)
		done <- err
	}()
	<-received
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancelled proxy connection to fail")
		}
	case <-time.After(time.Second):
		t.Fatal("CONNECT remained blocked after context cancellation")
	}
}
