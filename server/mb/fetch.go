package mb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"syscall"
	"time"
)

const maxImageBytes = 10 << 20

var imageExt = map[string]string{
	"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
}

// IsPublicAddr reports whether ip is a public unicast address (not loopback, private, link-local,
// CGNAT, multicast, unspecified, or an IPv4-mapped/NAT64 form of those).
func IsPublicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.Is6() {
		nat64 := netip.MustParsePrefix("64:ff9b::/96")
		if nat64.Contains(ip) {
			b := ip.As16()
			return IsPublicAddr(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
		}
	}
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	for _, p := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4", "::/96"} {
		if netip.MustParsePrefix(p).Contains(ip) {
			return false
		}
	}
	return true
}

// The check runs on the address actually dialled, so DNS rebinding between lookup and connect
// cannot reach a private host.
var safeClient = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 10 * time.Second,
			Control: func(_, address string, _ syscall.RawConn) error {
				ap, err := netip.ParseAddrPort(address)
				if err != nil || !IsPublicAddr(ap.Addr()) {
					return errors.New("image_url host is not public")
				}
				return nil
			},
		}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not allowed") },
}

// FetchImage downloads a public https image (max 10 MB) and returns its bytes and mime type.
func FetchImage(ctx context.Context, raw string) ([]byte, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, "", errors.New("image_url must be a valid https URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	res, err := safeClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("image fetch failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("image fetch failed: HTTP %d", res.StatusCode)
	}
	typ, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if imageExt[typ] == "" {
		return nil, "", fmt.Errorf("unsupported image type: %q", typ)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxImageBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(b) > maxImageBytes {
		return nil, "", errors.New("image too large")
	}
	return b, typ, nil
}
