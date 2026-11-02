package main

import (
	"crypto/x509"
	"fmt"
	"os"
	"sync"
)

var rootsOnce sync.Once
var explicitRoots *x509.CertPool
var rootsError error

// Honor an explicitly configured CA file on every supported OS. In particular,
// Go's native macOS verifier does not read SSL_CERT_FILE automatically.
func tlsRootCAs() (*x509.CertPool, error) {
	rootsOnce.Do(func() {
		filename := os.Getenv("SSL_CERT_FILE")
		if filename == "" {
			return
		}
		pem, err := os.ReadFile(filename)
		if err != nil {
			rootsError = fmt.Errorf("cannot read configured CA certificate file")
			return
		}
		explicitRoots, err = x509.SystemCertPool()
		if err != nil {
			explicitRoots = x509.NewCertPool()
		}
		if !explicitRoots.AppendCertsFromPEM(pem) {
			rootsError = fmt.Errorf("configured CA file contains no certificates")
		}
	})
	return explicitRoots, rootsError
}
