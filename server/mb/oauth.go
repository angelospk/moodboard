package mb

// A small OAuth 2.1 authorization server, only for MCP clients such as claude.ai connectors.
//
// Flow: the client finds /.well-known/oauth-protected-resource (from the 401 on /mcp), then
// /.well-known/oauth-authorization-server, registers itself (/oauth/register, public client, no
// secret), sends the user to /oauth/authorize (our own page: email + password, then a redirect with
// a one-time code) and swaps the code plus its PKCE verifier at /oauth/token.
//
// All secrets are random and stored only as SHA-256 hashes. Codes live 5 minutes and work once.
// Access tokens live 1 hour and work only on /mcp. Refresh tokens live 30 days and rotate: a used
// one stays as "used", and if it comes back (stolen and replayed) the whole family of tokens from
// that sign-in is revoked. Every token stores a hash of the user's tokenKey, which PocketBase
// changes on a password change, so a new password ends every grant.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html/template"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	codeTTL      = 5 * time.Minute
	accessTTL    = time.Hour
	refreshTTL   = 30 * 24 * time.Hour
	maxRedirects = 10
)

func issuer(app core.App) string { return strings.TrimRight(app.Settings().Meta.AppURL, "/") }

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

// validRedirect accepts https URLs and http only on loopback (native clients); no fragments.
func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.Host == "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		h := u.Hostname()
		return h == "localhost" || h == "127.0.0.1" || h == "::1"
	}
	return false
}

func bindOAuth(se *core.ServeEvent) {
	r := se.Router
	r.GET("/.well-known/oauth-protected-resource", handleResourceMeta)
	r.GET("/.well-known/oauth-protected-resource/{path...}", handleResourceMeta)
	r.GET("/.well-known/oauth-authorization-server", handleServerMeta)
	r.GET("/.well-known/oauth-authorization-server/{path...}", handleServerMeta)
	r.POST("/oauth/register", handleRegister)
	r.GET("/oauth/authorize", handleAuthorizePage)
	r.POST("/oauth/authorize", handleAuthorizeSubmit)
	r.POST("/oauth/token", handleToken)
}

// mcpChallenge turns a 401 on /mcp into one an MCP client can follow to the OAuth metadata.
// It accepts a PocketBase users token (from `moodboard mcp-token`) or an OAuth access token.
func mcpChallenge(e *core.RequestEvent) error {
	if e.Auth != nil && e.Auth.Collection().Name == "users" {
		return e.Next()
	}
	if u := accessUser(e.App, e.Request.Header.Get("Authorization")); u != nil {
		e.Auth = u
		return e.Next()
	}
	e.Response.Header().Set("WWW-Authenticate",
		`Bearer resource_metadata="`+issuer(e.App)+`/.well-known/oauth-protected-resource/mcp"`)
	return e.JSON(http.StatusUnauthorized, map[string]string{"error": "invalid_token", "error_description": "Sign in required."})
}

func handleResourceMeta(e *core.RequestEvent) error {
	iss := issuer(e.App)
	return e.JSON(http.StatusOK, map[string]any{
		"resource":                 iss + "/mcp",
		"authorization_servers":    []string{iss},
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "Moodboard",
	})
}

func handleServerMeta(e *core.RequestEvent) error {
	iss := issuer(e.App)
	return e.JSON(http.StatusOK, map[string]any{
		"issuer":                                iss,
		"authorization_endpoint":                iss + "/oauth/authorize",
		"token_endpoint":                        iss + "/oauth/token",
		"registration_endpoint":                 iss + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      []string{"mcp"},
	})
}

func oauthError(e *core.RequestEvent, status int, code, desc string) error {
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(status, map[string]string{"error": code, "error_description": desc})
}

func handleRegister(e *core.RequestEvent) error {
	var body struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(e.Response, e.Request.Body, 16<<10)).Decode(&body); err != nil {
		return oauthError(e, 400, "invalid_client_metadata", "Body must be JSON.")
	}
	if len(body.RedirectURIs) == 0 || len(body.RedirectURIs) > maxRedirects {
		return oauthError(e, 400, "invalid_redirect_uri", "1 to 10 redirect_uris are required.")
	}
	for _, u := range body.RedirectURIs {
		if !validRedirect(u) {
			return oauthError(e, 400, "invalid_redirect_uri", "redirect_uris must be https (or http on localhost).")
		}
	}
	name := strings.TrimSpace(body.ClientName)
	if len([]rune(name)) > 100 {
		name = string([]rune(name)[:100])
	}
	coll, err := e.App.FindCollectionByNameOrId("oauth_clients")
	if err != nil {
		return err
	}
	c := core.NewRecord(coll)
	c.Set("client_name", name)
	c.Set("redirect_uris", body.RedirectURIs)
	if err := e.App.Save(c); err != nil {
		return oauthError(e, 400, "invalid_client_metadata", "Could not register the client.")
	}
	return e.JSON(http.StatusCreated, map[string]any{
		"client_id":                  c.Id,
		"client_id_issued_at":        time.Now().Unix(),
		"client_name":                name,
		"redirect_uris":              body.RedirectURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

// authRequest is what /oauth/authorize receives, as query (GET) or form (POST).
type authRequest struct {
	ClientID, RedirectURI, State, Challenge, Method, ResponseType, Scope, Resource string
	client                                                                         *core.Record
}

func readAuthRequest(app core.App, r *http.Request, v url.Values) (*authRequest, string) {
	a := &authRequest{
		ClientID: v.Get("client_id"), RedirectURI: v.Get("redirect_uri"), State: v.Get("state"),
		Challenge: v.Get("code_challenge"), Method: v.Get("code_challenge_method"),
		ResponseType: v.Get("response_type"), Scope: v.Get("scope"), Resource: v.Get("resource"),
	}
	c, err := app.FindRecordById("oauth_clients", a.ClientID)
	if err != nil {
		return nil, tr(r, "Άγνωστη εφαρμογή (client_id).", "Unknown application (client_id).")
	}
	if !slices.Contains(stringList(c.Get("redirect_uris")), a.RedirectURI) {
		return nil, tr(r, "Η διεύθυνση επιστροφής (redirect_uri) δεν είναι δηλωμένη.", "The redirect address (redirect_uri) is not registered.")
	}
	a.client = c
	return a, ""
}

// redirect sends the user back to the client's registered redirect_uri. Only a successful sign-in
// redirects: with open registration, any error redirect would be an open redirect.
func (a *authRequest) redirect(e *core.RequestEvent, params url.Values) error {
	u, _ := url.Parse(a.RedirectURI)
	q := u.Query()
	for k, v := range params {
		q[k] = v
	}
	if a.State != "" {
		q.Set("state", a.State)
	}
	q.Set("iss", issuer(e.App))
	u.RawQuery = q.Encode()
	return e.Redirect(http.StatusFound, u.String())
}

func (a *authRequest) protocolError() string {
	switch {
	case a.ResponseType != "code":
		return "unsupported_response_type"
	case a.Challenge == "" || a.Method != "S256":
		return "invalid_request"
	}
	return ""
}

var consentPage = template.Must(template.New("consent").Parse(`<!doctype html>
<html lang="{{if .EN}}en{{else}}el{{end}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{if .EN}}Sign in{{else}}Σύνδεση{{end}} · Moodboard</title>
<style>
:root{color-scheme:light dark;--bg:#f4f1ea;--card:#fbfaf6;--ink:#1f1d1a;--muted:#6f6a62;--line:#ddd7cc;--accent:#b5532b}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262421;--ink:#ece8e0;--muted:#a49d92;--line:#3a3733}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{max-width:360px;margin:10vh auto;padding:0 16px}
h1{font:600 1.9rem Georgia,serif;margin:0 0 .25rem}
p{color:var(--muted);margin:0 0 1.25rem}
form{display:grid;gap:.6rem}
input{font:inherit;padding:.6rem .75rem;border:1px solid var(--line);border-radius:10px;background:var(--card);color:inherit}
button{font:inherit;padding:.65rem;border-radius:10px;border:0;background:var(--accent);color:#fff;cursor:pointer}
.err{color:#c0392b}
small{color:var(--muted);display:block;margin-top:1rem}
</style></head><body><main>
<h1>Moodboard</h1>
<p>{{if .EN}}The application <strong>{{.Client}}</strong> asks for access to your moodboard: to read projects and images, save new images and add notes.{{else}}Η εφαρμογή <strong>{{.Client}}</strong> ζητά πρόσβαση στο moodboard σου: να διαβάζει projects και εικόνες, να αποθηκεύει νέες εικόνες και να προσθέτει σημειώσεις.{{end}}</p>
<p>{{if .EN}}After you approve, it sends you to <strong>{{.Host}}</strong>. The application name is not verified: continue only if you added the connection there (for example <em>claude.ai</em>).{{else}}Μετά την έγκριση θα σε στείλει στο <strong>{{.Host}}</strong>. Το όνομα της εφαρμογής δεν είναι επαληθευμένο: συνέχισε μόνο αν εσύ πρόσθεσες τη σύνδεση εκεί (π.χ. <em>claude.ai</em>).{{end}}</p>
<form method="post" action="/oauth/authorize">
{{range $k, $v := .Hidden}}<input type="hidden" name="{{$k}}" value="{{$v}}">{{end}}
<input type="email" name="email" placeholder="email" value="{{.Email}}" required autocomplete="email" autofocus>
<input type="password" name="password" placeholder="{{if .EN}}password{{else}}κωδικός{{end}}" required autocomplete="current-password">
{{if .Error}}<div class="err">{{.Error}}</div>{{end}}
<button>{{if .EN}}Sign in and approve{{else}}Σύνδεση και έγκριση{{end}}</button>
</form>
<small>{{if .EN}}If you did not ask for this, close this page.{{else}}Αν δεν το ζήτησες εσύ, κλείσε αυτή τη σελίδα.{{end}}</small>
</main></body></html>`))

func renderConsent(e *core.RequestEvent, status int, a *authRequest, email, errMsg string) error {
	e.Response.Header().Set("X-Frame-Options", "DENY")
	e.Response.Header().Set("Content-Security-Policy", "frame-ancestors 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*")
	e.Response.Header().Set("Cache-Control", "no-store")
	e.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
	e.Response.WriteHeader(status)
	name := a.client.GetString("client_name")
	if name == "" {
		name = "MCP client"
	}
	return consentPage.Execute(e.Response, map[string]any{
		"EN": isEnglish(e.Request), "Client": name, "Email": email, "Error": errMsg, "Host": redirectHost(a.RedirectURI),
		"Hidden": map[string]string{
			"client_id": a.ClientID, "redirect_uri": a.RedirectURI, "state": a.State, "code_challenge": a.Challenge,
			"code_challenge_method": a.Method, "response_type": a.ResponseType, "scope": a.Scope, "resource": a.Resource,
		},
	})
}

func redirectHost(raw string) string {
	u, _ := url.Parse(raw)
	return u.Host
}

func plainError(e *core.RequestEvent, msg string) error {
	e.Response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	return e.String(http.StatusBadRequest, msg)
}

func handleAuthorizePage(e *core.RequestEvent) error {
	a, bad := readAuthRequest(e.App, e.Request, e.Request.URL.Query())
	if a == nil {
		return plainError(e, bad)
	}
	if pe := a.protocolError(); pe != "" {
		return plainError(e, tr(e.Request, "Μη έγκυρο αίτημα ("+pe+"): απαιτούνται response_type=code και PKCE S256.", "Invalid request ("+pe+"): response_type=code and PKCE S256 are required."))
	}
	return renderConsent(e, http.StatusOK, a, "", "")
}

func handleAuthorizeSubmit(e *core.RequestEvent) error {
	if err := e.Request.ParseForm(); err != nil {
		return plainError(e, tr(e.Request, "Λάθος αίτημα.", "Invalid request."))
	}
	a, bad := readAuthRequest(e.App, e.Request, e.Request.PostForm)
	if a == nil {
		return plainError(e, bad)
	}
	if pe := a.protocolError(); pe != "" {
		return plainError(e, tr(e.Request, "Μη έγκυρο αίτημα ("+pe+").", "Invalid request ("+pe+")."))
	}
	email := strings.TrimSpace(e.Request.PostForm.Get("email"))
	user, err := e.App.FindAuthRecordByEmail("users", email)
	if err != nil || !user.ValidatePassword(e.Request.PostForm.Get("password")) {
		return renderConsent(e, http.StatusUnauthorized, a, email, tr(e.Request, "Λάθος email ή κωδικός.", "Wrong email or password."))
	}
	code := randomToken()
	coll, err := e.App.FindCollectionByNameOrId("oauth_codes")
	if err != nil {
		return err
	}
	rec := core.NewRecord(coll)
	rec.Set("code_hash", hashToken(code))
	rec.Set("client", a.ClientID)
	rec.Set("user", user.Id)
	rec.Set("redirect_uri", a.RedirectURI)
	rec.Set("code_challenge", a.Challenge)
	exp, _ := types.ParseDateTime(time.Now().Add(codeTTL))
	rec.Set("expires", exp)
	if err := e.App.Save(rec); err != nil {
		return err
	}
	return a.redirect(e, url.Values{"code": {code}})
}

func pkceOK(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

func handleToken(e *core.RequestEvent) error {
	if err := e.Request.ParseForm(); err != nil {
		return oauthError(e, 400, "invalid_request", "Form body required.")
	}
	f := e.Request.PostForm
	clientID := f.Get("client_id")
	switch f.Get("grant_type") {
	case "authorization_code":
		// Delete first, check after: a code works once, even when this attempt fails.
		c, err := takeOnce(e.App, f.Get("code"))
		if err != nil || c.GetString("client") != clientID || c.GetString("redirect_uri") != f.Get("redirect_uri") ||
			c.GetDateTime("expires").Time().Before(time.Now()) || !pkceOK(f.Get("code_verifier"), c.GetString("code_challenge")) {
			return oauthError(e, 400, "invalid_grant", "The code is invalid, expired or already used.")
		}
		user, err := e.App.FindRecordById("users", c.GetString("user"))
		if err != nil {
			return oauthError(e, 400, "invalid_grant", "The user no longer exists.")
		}
		return issueTokens(e, clientID, user, randomToken())
	case "refresh_token":
		// Consume and issue in one write transaction. SQLite runs one writer at a time, so a
		// replay's revocation runs either before (then this UPDATE finds no unused row) or after
		// (then it also deletes the tokens issued here, which share the family).
		var access, refresh, family string
		err := e.App.RunInTransaction(func(tx core.App) error {
			r, err := useRefresh(tx, f.Get("refresh_token"))
			if err != nil {
				if r != nil {
					family = r.GetString("family")
				}
				return err
			}
			if r.GetString("client") != clientID || r.GetDateTime("expires").Time().Before(time.Now()) {
				return errNotFound
			}
			user, err := tx.FindRecordById("users", r.GetString("user"))
			if err != nil || r.GetString("key_hash") != keyHash(user) {
				family = r.GetString("family")
				return errRevoked
			}
			access, refresh, err = mintTokens(tx, clientID, user, r.GetString("family"))
			return err
		})
		if err != nil {
			if family != "" {
				if rerr := revokeFamily(e.App, family); rerr != nil {
					return rerr // 500; the used row stays, so the next replay tries again
				}
			}
			return oauthError(e, 400, "invalid_grant", "The refresh token is invalid, expired or revoked.")
		}
		return tokenResponse(e, access, refresh)
	}
	return oauthError(e, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.")
}

// keyHash fingerprints the user's tokenKey; PocketBase changes it on a password change.
func keyHash(user *core.Record) string { return hashToken(user.TokenKey()) }

// takeOnce finds a code by the hash of its secret and deletes it. Two parallel calls with the same
// code cannot both get it: only the one whose DELETE removed the row wins.
func takeOnce(app core.App, secret string) (*core.Record, error) {
	if secret == "" {
		return nil, errNotFound
	}
	rec, err := app.FindFirstRecordByData("oauth_codes", "code_hash", hashToken(secret))
	if err != nil {
		return nil, errNotFound
	}
	res, err := app.DB().NewQuery("DELETE FROM oauth_codes WHERE id = {:id}").Bind(dbx.Params{"id": rec.Id}).Execute()
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return nil, errNotFound
	}
	return rec, nil
}

// useRefresh marks a refresh token as used, once. A token that was already used is a replay
// (the client never sends one twice): it returns the record with errRevoked, and the caller
// revokes the whole family after the transaction.
func useRefresh(app core.App, secret string) (*core.Record, error) {
	if secret == "" {
		return nil, errNotFound
	}
	rec, err := app.FindFirstRecordByData("oauth_refresh_tokens", "token_hash", hashToken(secret))
	if err != nil {
		return nil, errNotFound
	}
	res, err := app.DB().NewQuery("UPDATE oauth_refresh_tokens SET used = TRUE WHERE id = {:id} AND used = FALSE").
		Bind(dbx.Params{"id": rec.Id}).Execute()
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return rec, errRevoked
	}
	return rec, nil
}

var errRevoked = errors.New("grant revoked")

// revokeFamily deletes every token of one sign-in, all or nothing.
func revokeFamily(app core.App, family string) error {
	return app.RunInTransaction(func(tx core.App) error {
		for _, c := range []string{"oauth_refresh_tokens", "oauth_access_tokens"} {
			if _, err := tx.DB().NewQuery("DELETE FROM " + c + " WHERE family = {:f}").Bind(dbx.Params{"f": family}).Execute(); err != nil {
				return err
			}
		}
		return nil
	})
}

func issueTokens(e *core.RequestEvent, clientID string, user *core.Record, family string) error {
	access, refresh, err := mintTokens(e.App, clientID, user, family)
	if err != nil {
		return err
	}
	return tokenResponse(e, access, refresh)
}

// mintTokens stores a new access and refresh token of one family (hashes only) and returns them.
func mintTokens(app core.App, clientID string, user *core.Record, family string) (string, string, error) {
	access, refresh := randomToken(), randomToken()
	for _, t := range []struct {
		coll, secret string
		ttl          time.Duration
	}{{"oauth_access_tokens", access, accessTTL}, {"oauth_refresh_tokens", refresh, refreshTTL}} {
		c, err := app.FindCollectionByNameOrId(t.coll)
		if err != nil {
			return "", "", err
		}
		r := core.NewRecord(c)
		r.Set("token_hash", hashToken(t.secret))
		r.Set("family", family)
		r.Set("client", clientID)
		r.Set("user", user.Id)
		r.Set("key_hash", keyHash(user))
		exp, _ := types.ParseDateTime(time.Now().Add(t.ttl))
		r.Set("expires", exp)
		if err := app.Save(r); err != nil {
			return "", "", err
		}
	}
	return access, refresh, nil
}

func tokenResponse(e *core.RequestEvent, access, refresh string) error {
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.JSON(http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(accessTTL.Seconds()),
		"refresh_token": refresh,
		"scope":         "mcp",
	})
}

// accessUser returns the user of a valid OAuth access token, or nil.
func accessUser(app core.App, header string) *core.Record {
	tok, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || tok == "" {
		return nil
	}
	a, err := app.FindFirstRecordByData("oauth_access_tokens", "token_hash", hashToken(strings.TrimSpace(tok)))
	if err != nil || a.GetDateTime("expires").Time().Before(time.Now()) {
		return nil
	}
	user, err := app.FindRecordById("users", a.GetString("user"))
	if err != nil || a.GetString("key_hash") != keyHash(user) {
		return nil
	}
	return user
}

// cleanupOAuth drops expired codes and access tokens (runs hourly). Refresh tokens go only when
// their whole family has expired: a used one must stay while its successors live, so a late
// replay of it is still seen and revokes the family.
func cleanupOAuth(app core.App) {
	now := dbx.Params{"now": types.NowDateTime().String()}
	for _, c := range []string{"oauth_codes", "oauth_access_tokens"} {
		_, _ = app.DB().NewQuery("DELETE FROM " + c + " WHERE expires < {:now}").Bind(now).Execute()
	}
	_, _ = app.DB().NewQuery(`DELETE FROM oauth_refresh_tokens WHERE family IN
		(SELECT family FROM oauth_refresh_tokens GROUP BY family HAVING MAX(expires) < {:now})`).Bind(now).Execute()
}
