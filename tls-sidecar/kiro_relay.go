package main

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
)

var kiroRelayRequests atomic.Uint64

type proxyStatusError struct{ status int }

func (err *proxyStatusError) Error() string {
	return fmt.Sprintf("proxy CONNECT rejected (status %d)", err.status)
}

// The dedicated endpoint has explicit local/upstream markers. The generic
// reverse-proxy endpoint keeps its existing response contract for other users.
func handleKiroProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("X-Kiro-Protocol-Version") != "1" {
		writeProxyError(w, true, http.StatusBadRequest, "SIDECAR_PROTOCOL_ERROR", nil)
		return
	}
	kiroRelayRequests.Add(1)
	proxyRequest(w, r, true)
}

func writeProxyError(w http.ResponseWriter, kiro bool, status int, code string, _ error) {
	w.Header().Set("Content-Type", "application/json")
	if kiro {
		w.Header().Set("X-Kiro-Protocol-Version", "1")
		w.Header().Set("X-Kiro-Response-Source", "sidecar")
		w.Header().Set("X-Kiro-Error-Code", code)
	}
	w.WriteHeader(status)
	// Never return an error string containing URLs or proxy credentials.
	json.NewEncoder(w).Encode(map[string]string{"error": code, "source": "sidecar", "code": code})
}

func classifyProxyError(err error, proxied bool) string {
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var dns *net.DNSError
	var network net.Error
	var proxyStatus *proxyStatusError
	detail := strings.ToLower(err.Error())
	switch {
	case errors.As(err, &proxyStatus) && proxyStatus.status == http.StatusProxyAuthRequired,
		strings.Contains(detail, "authentication failed"), strings.Contains(detail, "username/password authentication"):
		return "PROXY_AUTH_FAILED"
	case errors.As(err, &unknown), errors.As(err, &hostname), errors.As(err, &invalid), strings.Contains(detail, "certificate"), strings.Contains(detail, "tls handshake"):
		return "TLS_ERROR"
	case errors.As(err, &network) && network.Timeout():
		return "CONNECT_TIMEOUT"
	case errors.As(err, &dns):
		return "DNS_ERROR"
	case proxied:
		return "PROXY_CONNECT_ERROR"
	default:
		// Legacy fallback for unclassified RoundTrip failures; this code alone
		// does not prove that connecting or TLS negotiation already succeeded.
		return "UPSTREAM_HEADERS_ERROR"
	}
}

func validKiroProxy(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.Port() == "0" || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "socks5", "socks5h":
		return true
	default:
		return false
	}
}

func connectionHeader(headers http.Header, name string) bool {
	for _, options := range headers.Values("Connection") {
		for _, option := range strings.Split(options, ",") {
			if strings.EqualFold(strings.TrimSpace(option), name) {
				return true
			}
		}
	}
	return false
}

func hopByHopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection", "proxy-authenticate", "proxy-authorization":
		return true
	default:
		return false
	}
}
