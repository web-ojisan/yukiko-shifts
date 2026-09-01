package main

import (
	"net/url"
	"testing"
)

func TestMaskURI(t *testing.T) {
	cases := []struct {
		name string
		uri  string
		want string
	}{
		{"qr-loginのクエリはマスクされる", "/qr-login?token=abcdef1234567890", "/qr-login?token=***"},
		{"qr-loginでクエリなしはそのまま", "/qr-login", "/qr-login"},
		{"通常のAPIパスはそのまま", "/api/shifts/board?from=2026-09-01&to=2026-09-07", "/api/shifts/board?from=2026-09-01&to=2026-09-07"},
		{"静的ファイルはそのまま", "/static/js/board.js", "/static/js/board.js"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u, err := url.ParseRequestURI(c.uri)
			if err != nil {
				t.Fatalf("ParseRequestURI(%q): %v", c.uri, err)
			}
			if got := maskURI(u); got != c.want {
				t.Errorf("maskURI(%q) = %q, want %q", c.uri, got, c.want)
			}
		})
	}
}
