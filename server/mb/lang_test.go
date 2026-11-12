package mb_test

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// get sends a request with an Accept-Language header and returns the status and body.
func (e *env) getLang(method, url, token, lang, body string) (int, string) {
	e.t.Helper()
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if lang != "" {
		r.Header.Set("Accept-Language", lang)
	}
	if token != "" {
		r.Header.Set("Authorization", token)
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func TestServerMessagesFollowAcceptLanguage(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	api := "/api/collections/levels/records"
	dup := `{"user_id":"` + alice.Id + `","name":"αστικό","position":9}`
	for lang, want := range map[string]string{
		"":                  "Υπάρχει ήδη επίπεδο",
		"el-GR,el;q=0.9":    "Υπάρχει ήδη επίπεδο",
		"en-GB":             "A level with this name already exists.",
		"fr, en;q=0.8":      "A level with this name already exists.",
		"de-DE":             "Υπάρχει ήδη επίπεδο",
		"en;q=0,el;q=1":     "Υπάρχει ήδη επίπεδο",
		"el;q=0.5,en;q=0.8": "A level with this name already exists.",
	} {
		code, out := e.getLang("POST", api, aTok, lang, dup)
		if code != 400 || !strings.Contains(out, want) {
			t.Fatalf("lang %q: want %q, got %d %s", lang, want, code, out)
		}
	}
}

func TestOAuthPageFollowsAcceptLanguage(t *testing.T) {
	e := newEnv(t)
	for lang, want := range map[string]string{"": "Άγνωστη εφαρμογή", "en": "Unknown application"} {
		code, out := e.getLang("GET", "/oauth/authorize?client_id=nope", "", lang, "")
		if code != 400 || !strings.Contains(out, want) {
			t.Fatalf("lang %q: want %q, got %d %s", lang, want, code, out)
		}
	}
}
