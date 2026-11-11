package mb_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"moodboard/server/mb"
)

const verifier = "a-long-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz"

func challenge(v string) string {
	s := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(s[:])
}

// form posts a urlencoded form and returns status, body and the Location header.
func (e *env) form(path string, v url.Values) (int, string, string) {
	e.t.Helper()
	r := httptest.NewRequest("POST", path, strings.NewReader(v.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w.Code, w.Body.String(), w.Header().Get("Location")
}

func TestOAuthMetadataAndChallenge(t *testing.T) {
	e := newEnv(t)
	code, out := e.req("GET", "/.well-known/oauth-protected-resource/mcp", "", nil, "")
	if code != 200 || !strings.Contains(out, `"resource":"https://moodboard-api.haroldpoi.dev/mcp"`) {
		t.Fatalf("resource meta: %d %s", code, out)
	}
	code, out = e.req("GET", "/.well-known/oauth-authorization-server", "", nil, "")
	if code != 200 || !strings.Contains(out, `"token_endpoint":"https://moodboard-api.haroldpoi.dev/oauth/token"`) || !strings.Contains(out, `"S256"`) {
		t.Fatalf("server meta: %d %s", code, out)
	}
	r := httptest.NewRequest("POST", "/mcp", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	if w.Code != 401 || !strings.Contains(w.Header().Get("WWW-Authenticate"), `resource_metadata="https://moodboard-api.haroldpoi.dev/.well-known/oauth-protected-resource/mcp"`) {
		t.Fatalf("mcp 401: %d %q", w.Code, w.Header().Get("WWW-Authenticate"))
	}
}

func TestOAuthRegisterRejectsPlainHTTP(t *testing.T) {
	e := newEnv(t)
	for _, u := range []string{"http://evil.example/cb", "https://x.example/cb#frag", "javascript:alert(1)"} {
		if code, out := e.json("POST", "/oauth/register", "", map[string]any{"redirect_uris": []string{u}}); code != 400 {
			t.Fatalf("%s: want 400, got %d %s", u, code, out)
		}
	}
	if code, out := e.json("POST", "/oauth/register", "", map[string]any{"redirect_uris": []string{"http://localhost:33418/cb"}}); code != 201 {
		t.Fatalf("localhost: want 201, got %d %s", code, out)
	}
}

func TestOAuthFullFlow(t *testing.T) {
	e := newEnv(t)
	e.user("a@x.gr")
	const cb = "https://claude.ai/api/mcp/auth_callback"

	code, out := e.json("POST", "/oauth/register", "", map[string]any{"redirect_uris": []string{cb}, "client_name": "Claude"})
	if code != 201 {
		t.Fatalf("register: %d %s", code, out)
	}
	var reg struct {
		ClientID string `json:"client_id"`
	}
	_ = json.Unmarshal([]byte(out), &reg)

	q := url.Values{"response_type": {"code"}, "client_id": {reg.ClientID}, "redirect_uri": {cb}, "state": {"st8"},
		"code_challenge": {challenge(verifier)}, "code_challenge_method": {"S256"}}

	if code, out := e.req("GET", "/oauth/authorize?"+q.Encode(), "", nil, ""); code != 200 || !strings.Contains(out, "Claude") || !strings.Contains(out, `name="password"`) {
		t.Fatalf("authorize page: %d %s", code, out)
	}
	bad := url.Values{}
	for k, v := range q {
		bad[k] = v
	}
	bad.Set("redirect_uri", "https://evil.example/cb")
	if code, _ := e.req("GET", "/oauth/authorize?"+bad.Encode(), "", nil, ""); code != 400 {
		t.Fatalf("unregistered redirect: want 400, got %d", code)
	}

	post := url.Values{}
	for k, v := range q {
		post[k] = v
	}
	post.Set("email", "a@x.gr")
	post.Set("password", "wrong-password")
	if code, out, _ := e.form("/oauth/authorize", post); code != 401 || !strings.Contains(out, "Λάθος email ή κωδικός") {
		t.Fatalf("wrong password: %d %s", code, out)
	}
	post.Set("password", "password123")
	code, _, loc := e.form("/oauth/authorize", post)
	if code != 302 || !strings.HasPrefix(loc, cb+"?") {
		t.Fatalf("authorize: %d %q", code, loc)
	}
	lu, _ := url.Parse(loc)
	authCode := lu.Query().Get("code")
	if authCode == "" || lu.Query().Get("state") != "st8" {
		t.Fatalf("redirect params: %q", loc)
	}

	tok := url.Values{"grant_type": {"authorization_code"}, "code": {authCode}, "redirect_uri": {cb}, "client_id": {reg.ClientID}}
	// A wrong verifier burns the code too (one use, whatever happens).
	w := url.Values{}
	for k, v := range tok {
		w[k] = v
	}
	w.Set("code_verifier", strings.Repeat("x", 50))
	if code, out, _ := e.form("/oauth/token", w); code != 400 || !strings.Contains(out, "invalid_grant") {
		t.Fatalf("wrong verifier: %d %s", code, out)
	}
	tok.Set("code_verifier", verifier)
	if code, _, _ := e.form("/oauth/token", tok); code != 400 {
		t.Fatalf("burned code: want 400, got %d", code)
	}

	// A fresh code, the right verifier.
	_, _, loc = e.form("/oauth/authorize", post)
	lu, _ = url.Parse(loc)
	tok.Set("code", lu.Query().Get("code"))
	code, out, _ = e.form("/oauth/token", tok)
	if code != 200 {
		t.Fatalf("token: %d %s", code, out)
	}
	var tr struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
	}
	_ = json.Unmarshal([]byte(out), &tr)
	if code, _, _ := e.form("/oauth/token", tok); code != 400 {
		t.Fatalf("code reuse: want 400, got %d", code)
	}
	if code, out := mcpCall(e, "Bearer "+tr.Access, "tools/list", map[string]any{}); code != 200 || !strings.Contains(out, "list_projects") {
		t.Fatalf("mcp with oauth token: %d %s", code, out)
	}

	ref := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tr.Refresh}, "client_id": {reg.ClientID}}
	code, out, _ = e.form("/oauth/token", ref)
	if code != 200 || !strings.Contains(out, "access_token") {
		t.Fatalf("refresh: %d %s", code, out)
	}
	if code, _, _ := e.form("/oauth/token", ref); code != 400 {
		t.Fatalf("rotated refresh token: want 400, got %d", code)
	}
}

// signIn runs register + authorize + token for a user and returns client id and tokens.
func signIn(t *testing.T, e *env, email string) (clientID, access, refresh string) {
	t.Helper()
	const cb = "https://claude.ai/api/mcp/auth_callback"
	_, out := e.json("POST", "/oauth/register", "", map[string]any{"redirect_uris": []string{cb}})
	var reg struct {
		ClientID string `json:"client_id"`
	}
	_ = json.Unmarshal([]byte(out), &reg)
	post := url.Values{"response_type": {"code"}, "client_id": {reg.ClientID}, "redirect_uri": {cb},
		"code_challenge": {challenge(verifier)}, "code_challenge_method": {"S256"}, "email": {email}, "password": {"password123"}}
	_, _, loc := e.form("/oauth/authorize", post)
	lu, _ := url.Parse(loc)
	code, out, _ := e.form("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {lu.Query().Get("code")},
		"redirect_uri": {cb}, "client_id": {reg.ClientID}, "code_verifier": {verifier}})
	if code != 200 {
		t.Fatalf("sign in: %d %s", code, out)
	}
	var tr struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
	}
	_ = json.Unmarshal([]byte(out), &tr)
	return reg.ClientID, tr.Access, tr.Refresh
}

func refreshWith(e *env, clientID, rt string) (int, string, string) {
	code, out, _ := e.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rt}, "client_id": {clientID}})
	var tr struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
	}
	_ = json.Unmarshal([]byte(out), &tr)
	return code, tr.Access, tr.Refresh
}

func TestOAuthReplayRevokesFamily(t *testing.T) {
	e := newEnv(t)
	e.user("a@x.gr")
	cid, _, rt1 := signIn(t, e, "a@x.gr")
	code, at2, rt2 := refreshWith(e, cid, rt1) // the attacker refreshes first
	if code != 200 {
		t.Fatalf("first refresh: %d", code)
	}
	if code, _, _ := refreshWith(e, cid, rt1); code != 400 { // the real client replays rt1
		t.Fatalf("replay: want 400, got %d", code)
	}
	if code, _, _ := refreshWith(e, cid, rt2); code != 400 {
		t.Fatalf("successor refresh after replay: want 400, got %d", code)
	}
	if code, _ := mcpCall(e, "Bearer "+at2, "tools/list", map[string]any{}); code != 401 {
		t.Fatalf("successor access after replay: want 401, got %d", code)
	}
}

func TestOAuthPasswordChangeEndsGrant(t *testing.T) {
	e := newEnv(t)
	u, _ := e.user("a@x.gr")
	cid, at, rt := signIn(t, e, "a@x.gr")
	u.SetPassword("another-password-1")
	if err := e.app.Save(u); err != nil {
		t.Fatal(err)
	}
	if code, _ := mcpCall(e, "Bearer "+at, "tools/list", map[string]any{}); code != 401 {
		t.Fatalf("access after password change: want 401, got %d", code)
	}
	if code, _, _ := refreshWith(e, cid, rt); code != 400 {
		t.Fatalf("refresh after password change: want 400, got %d", code)
	}
}

func TestOAuthTokenOnlyForMCP(t *testing.T) {
	e := newEnv(t)
	e.user("a@x.gr")
	_, at, _ := signIn(t, e, "a@x.gr")
	if code, _ := e.req("GET", "/api/mb/tags", "Bearer "+at, nil, ""); code != 401 {
		t.Fatalf("oauth token on /api/mb: want 401, got %d", code)
	}
	if code, _ := mcpCall(e, "Bearer "+at, "tools/list", map[string]any{}); code != 200 {
		t.Fatalf("oauth token on /mcp: want 200, got %d", code)
	}
}

func TestOAuthProtocolErrorDoesNotRedirect(t *testing.T) {
	e := newEnv(t)
	const cb = "https://evil.example/cb"
	_, out := e.json("POST", "/oauth/register", "", map[string]any{"redirect_uris": []string{cb}})
	var reg struct {
		ClientID string `json:"client_id"`
	}
	_ = json.Unmarshal([]byte(out), &reg)
	q := url.Values{"response_type": {"token"}, "client_id": {reg.ClientID}, "redirect_uri": {cb}}
	r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	if w.Code != 400 || w.Header().Get("Location") != "" {
		t.Fatalf("protocol error: want 400 without redirect, got %d %q", w.Code, w.Header().Get("Location"))
	}
	q.Set("response_type", "code")
	q.Set("code_challenge", challenge(verifier))
	q.Set("code_challenge_method", "S256")
	if code, out := e.req("GET", "/oauth/authorize?"+q.Encode(), "", nil, ""); code != 200 || !strings.Contains(out, "evil.example") {
		t.Fatalf("consent page must show the redirect host: %d", code)
	}
}

func TestOAuthParallelReplayKillsSuccessor(t *testing.T) {
	e := newEnv(t)
	e.user("a@x.gr")
	cid, _, rt1 := signIn(t, e, "a@x.gr")
	type res struct {
		code    int
		refresh string
	}
	ch := make(chan res, 2)
	for range 2 {
		go func() { c, _, r := refreshWith(e, cid, rt1); ch <- res{c, r} }()
	}
	a, b := <-ch, <-ch
	if (a.code == 200) == (b.code == 200) {
		t.Fatalf("exactly one parallel refresh must win: %d %d", a.code, b.code)
	}
	winner := a.refresh + b.refresh
	if code, _, _ := refreshWith(e, cid, winner); code != 400 {
		t.Fatalf("successor after replay: want 400, got %d", code)
	}
}

func TestOAuthCleanupKeepsLiveFamilies(t *testing.T) {
	e := newEnv(t)
	e.user("a@x.gr")
	cid, _, rt1 := signIn(t, e, "a@x.gr")
	_, _, rt2 := refreshWith(e, cid, rt1)
	// rt1 (used) expires; its successor rt2 still lives.
	if _, err := e.app.DB().NewQuery("UPDATE oauth_refresh_tokens SET expires = '2000-01-01 00:00:00.000Z' WHERE used = TRUE").Execute(); err != nil {
		t.Fatal(err)
	}
	mb.CleanupOAuth(e.app)
	if code, _, _ := refreshWith(e, cid, rt1); code != 400 {
		t.Fatalf("expired ancestor: want 400, got %d", code)
	}
	if code, _, _ := refreshWith(e, cid, rt2); code != 400 {
		t.Fatalf("late replay of an expired ancestor must still revoke the family: got %d", code)
	}
	// A family that has fully expired is removed.
	if _, err := e.app.DB().NewQuery("UPDATE oauth_refresh_tokens SET expires = '2000-01-01 00:00:00.000Z'").Execute(); err != nil {
		t.Fatal(err)
	}
	mb.CleanupOAuth(e.app)
	var n int
	_ = e.app.DB().NewQuery("SELECT COUNT(*) FROM oauth_refresh_tokens").Row(&n)
	if n != 0 {
		t.Fatalf("expired family left %d rows", n)
	}
}
