package mb_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"golang.org/x/crypto/bcrypt"

	"moodboard/server/mb"
	_ "moodboard/server/migrations"
)

// 1x1 transparent PNG.
var png1x1, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")

type env struct {
	t   *testing.T
	app *tests.TestApp
	mux http.Handler
}

func newEnv(t *testing.T) *env {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	t.Cleanup(mb.WaitThumbs) // runs before app.Cleanup: no thumbnail writes into a removed dir
	mb.Register(app)
	r, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	se := &core.ServeEvent{App: app, Router: r}
	var mux http.Handler
	if err := app.OnServe().Trigger(se, func(e *core.ServeEvent) error {
		m, err := e.Router.BuildMux()
		mux = m
		return err
	}); err != nil {
		t.Fatal(err)
	}
	mb.WaitThumbs() // the startup backfill
	return &env{t: t, app: app, mux: mux}
}

func (e *env) req(method, url, token string, body io.Reader, ctype string) (int, string) {
	e.t.Helper()
	r := httptest.NewRequest(method, url, body)
	if ctype == "" {
		ctype = "application/json"
	}
	r.Header.Set("Content-Type", ctype)
	r.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		r.Header.Set("Authorization", token)
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func (e *env) json(method, url, token string, v any) (int, string) {
	b, _ := json.Marshal(v)
	return e.req(method, url, token, bytes.NewReader(b), "")
}

func (e *env) user(email string) (*core.Record, string) {
	e.t.Helper()
	c, _ := e.app.FindCollectionByNameOrId("users")
	u := core.NewRecord(c)
	u.SetEmail(email)
	u.SetPassword("password123")
	if err := e.app.Save(u); err != nil {
		e.t.Fatal(err)
	}
	tok, err := u.NewAuthToken()
	if err != nil {
		e.t.Fatal(err)
	}
	return u, tok
}

func (e *env) record(coll string, fields map[string]any) *core.Record {
	e.t.Helper()
	c, _ := e.app.FindCollectionByNameOrId(coll)
	r := core.NewRecord(c)
	for k, v := range fields {
		r.Set(k, v)
	}
	if err := e.app.Save(r); err != nil {
		e.t.Fatal(coll, err)
	}
	return r
}

// upload creates an inspiration through the public API (multipart, like the web client).
func (e *env) upload(token string, fields map[string]string) (int, string) {
	e.t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	h := make(map[string][]string)
	h["Content-Disposition"] = []string{`form-data; name="image"; filename="a.png"`}
	h["Content-Type"] = []string{"image/png"}
	part, _ := w.CreatePart(h)
	_, _ = part.Write(png1x1)
	_ = w.Close()
	return e.req("POST", "/api/collections/inspirations/records", token, &buf, w.FormDataContentType())
}

func TestSignupNeedsValidInvite(t *testing.T) {
	e := newEnv(t)
	e.record("invites", map[string]any{"code": "WELCOME1", "uses_left": 1})
	body := func(invite string, email string) map[string]any {
		return map[string]any{"email": email, "password": "password123", "passwordConfirm": "password123", "invite": invite}
	}
	if code, out := e.json("POST", "/api/collections/users/records", "", body("", "a@x.gr")); code != 400 {
		t.Fatalf("no invite: want 400, got %d %s", code, out)
	}
	if code, out := e.json("POST", "/api/collections/users/records", "", body("WRONG123", "a@x.gr")); code != 400 {
		t.Fatalf("wrong invite: want 400, got %d %s", code, out)
	}
	if code, out := e.json("POST", "/api/collections/users/records", "", body("WELCOME1", "a@x.gr")); code != 200 {
		t.Fatalf("valid invite: want 200, got %d %s", code, out)
	}
	if code, out := e.json("POST", "/api/collections/users/records", "", body("WELCOME1", "b@x.gr")); code != 400 {
		t.Fatalf("used-up invite: want 400, got %d %s", code, out)
	}
	inv, _ := e.app.FindFirstRecordByData("invites", "code", "WELCOME1")
	if inv.GetInt("uses_left") != 0 {
		t.Fatalf("uses_left = %d, want 0", inv.GetInt("uses_left"))
	}
}

func TestInspirationOwnership(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	bob, bTok := e.user("bob@x.gr")
	bobProject := e.record("projects", map[string]any{"user_id": bob.Id, "name": "Bob"})
	aliceProject := e.record("projects", map[string]any{"user_id": alice.Id, "name": "Alice"})

	if code, out := e.upload(aTok, map[string]string{"user_id": bob.Id}); code != 400 {
		t.Fatalf("create as another user: want 400, got %d %s", code, out)
	}
	if code, out := e.upload(aTok, map[string]string{"user_id": alice.Id, "project_id": bobProject.Id}); code != 400 {
		t.Fatalf("create in another user's project: want 400, got %d %s", code, out)
	}
	code, out := e.upload(aTok, map[string]string{"user_id": alice.Id, "project_id": aliceProject.Id, "tags": `[" Wood ","wood","Stone"]`})
	if code != 200 {
		t.Fatalf("own create: want 200, got %d %s", code, out)
	}
	var created struct {
		Id      string   `json:"id"`
		Tags    []string `json:"tags"`
		Regions []any    `json:"regions"`
	}
	_ = json.Unmarshal([]byte(out), &created)
	if strings.Join(created.Tags, ",") != "wood,stone" || created.Regions == nil {
		t.Fatalf("tags/regions not normalised: %s", out)
	}

	url := "/api/collections/inspirations/records/" + created.Id
	if code, _ := e.req("GET", url, bTok, nil, ""); code != 404 {
		t.Fatalf("bob reads alice's row: want 404, got %d", code)
	}
	if code, out := e.req("GET", "/api/collections/inspirations/records", bTok, nil, ""); code != 200 || !strings.Contains(out, `"totalItems":0`) {
		t.Fatalf("bob lists: want 0 items, got %d %s", code, out)
	}
	if code, _ := e.json("PATCH", url, bTok, map[string]any{"note": "x"}); code != 404 {
		t.Fatalf("bob updates alice's row: want 404, got %d", code)
	}
	if code, out := e.json("PATCH", url, aTok, map[string]any{"user_id": bob.Id}); code < 400 {
		t.Fatalf("alice moves row to bob: want 4xx, got %d %s", code, out)
	}
	if code, out := e.json("PATCH", url, aTok, map[string]any{"project_id": bobProject.Id}); code != 400 {
		t.Fatalf("alice moves row into bob's project: want 400, got %d %s", code, out)
	}
	if code, out := e.json("PATCH", url, aTok, map[string]any{"note": "hello", "project_id": ""}); code != 200 {
		t.Fatalf("alice edits own row: want 200, got %d %s", code, out)
	}
	if code, _ := e.req("DELETE", url, bTok, nil, ""); code != 404 {
		t.Fatalf("bob deletes alice's row: want 404, got %d", code)
	}
	if code, _ := e.json("POST", "/api/collections/projects/records", aTok, map[string]any{"user_id": bob.Id, "name": "x"}); code != 400 {
		t.Fatalf("project for another user: want 400, got %d", code)
	}
	if code, _ := e.json("POST", "/api/collections/map_positions/records", aTok, map[string]any{"user_id": bob.Id, "scope": "all", "node_key": "t:x"}); code != 400 {
		t.Fatalf("position for another user: want 400, got %d", code)
	}
}

func TestCustomRoutes(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	_, bTok := e.user("bob@x.gr")
	p := e.record("projects", map[string]any{"user_id": alice.Id, "name": "P"})
	_, out := e.upload(aTok, map[string]string{"user_id": alice.Id, "tags": `["wood","stone"]`, "note": "first"})
	var a struct{ Id string }
	_ = json.Unmarshal([]byte(out), &a)
	_, _ = e.upload(aTok, map[string]string{"user_id": alice.Id, "tags": `["wood"]`})

	if code, out := e.req("GET", "/api/mb/tags", "", nil, ""); code != 401 {
		t.Fatalf("tags without auth: want 401, got %d %s", code, out)
	}
	if code, out := e.req("GET", "/api/mb/tags", aTok, nil, ""); code != 200 || strings.TrimSpace(out) != `["wood","stone"]` {
		t.Fatalf("tags: got %d %s", code, out)
	}
	if code, out := e.req("GET", "/api/mb/tags", bTok, nil, ""); strings.TrimSpace(out) != `[]` {
		t.Fatalf("bob tags: got %d %s", code, out)
	}

	if code, _ := e.json("POST", "/api/mb/inspirations/"+a.Id+"/note", bTok, map[string]any{"text": "x"}); code != 404 {
		t.Fatalf("bob appends: want 404, got %d", code)
	}
	if code, out := e.json("POST", "/api/mb/inspirations/"+a.Id+"/note", aTok, map[string]any{"text": " second "}); code != 200 || !strings.Contains(out, `first\n\nsecond`) {
		t.Fatalf("append: got %d %s", code, out)
	}

	if code, _ := e.json("POST", "/api/mb/inspirations/"+a.Id+"/copy", bTok, map[string]any{"project_id": nil}); code != 404 {
		t.Fatalf("bob copies: want 404, got %d", code)
	}
	code, out := e.json("POST", "/api/mb/inspirations/"+a.Id+"/copy", aTok, map[string]any{"project_id": p.Id})
	if code != 200 {
		t.Fatalf("copy: got %d %s", code, out)
	}
	var c struct{ Id string }
	_ = json.Unmarshal([]byte(out), &c)
	cp, err := e.app.FindRecordById("inspirations", c.Id)
	if err != nil || cp.GetString("project_id") != p.Id || cp.GetString("image") == "" || cp.GetString("note") != "first\n\nsecond" {
		t.Fatalf("copy wrong: %v %v", err, cp)
	}
	orig, _ := e.app.FindRecordById("inspirations", a.Id)
	if cp.GetString("image") == orig.GetString("image") && cp.BaseFilesPath() == orig.BaseFilesPath() {
		t.Fatal("copy shares the original file")
	}

	pos := map[string]any{"scope": "all", "positions": []map[string]any{{"key": "t:wood", "x": 1, "y": 2}, {"key": "i:" + a.Id, "x": 3, "y": 4}}}
	if code, out := e.json("POST", "/api/mb/positions", aTok, pos); code != 204 {
		t.Fatalf("save positions: %d %s", code, out)
	}
	pos["positions"] = []map[string]any{{"key": "t:wood", "x": 9, "y": 9}}
	_, _ = e.json("POST", "/api/mb/positions", aTok, pos)
	_, _ = e.json("POST", "/api/mb/positions", aTok, map[string]any{"scope": p.Id, "positions": []map[string]any{{"key": "t:wood", "x": 5, "y": 5}}})
	rs, _ := e.app.FindAllRecords("map_positions")
	if len(rs) != 3 {
		t.Fatalf("want 3 positions (upsert), got %d", len(rs))
	}
	w, _ := e.app.FindFirstRecordByFilter("map_positions", "scope = 'all' && node_key = 't:wood'")
	if w.GetFloat("x") != 9 {
		t.Fatalf("upsert did not update x: %v", w.GetFloat("x"))
	}
	_, _ = e.json("POST", "/api/mb/positions/delete", bTok, map[string]any{"key": "t:wood"})
	if rs, _ := e.app.FindAllRecords("map_positions"); len(rs) != 3 {
		t.Fatal("bob deleted alice's positions")
	}
	_, _ = e.json("POST", "/api/mb/positions/delete", aTok, map[string]any{"scope": "all", "key": "t:wood"})
	if rs, _ := e.app.FindAllRecords("map_positions"); len(rs) != 2 {
		t.Fatalf("scoped delete: want 2 left, got %d", len(rs))
	}
	_, _ = e.json("POST", "/api/mb/positions/delete", aTok, map[string]any{"key": "t:wood"})
	if rs, _ := e.app.FindAllRecords("map_positions"); len(rs) != 1 {
		t.Fatalf("all-scope delete: want 1 left, got %d", len(rs))
	}
	_, _ = e.json("POST", "/api/mb/positions/delete", aTok, map[string]any{"scope": "all", "keys": []string{"i:" + a.Id, "t:none"}})
	if rs, _ := e.app.FindAllRecords("map_positions"); len(rs) != 0 {
		t.Fatalf("bulk delete: want 0 left, got %d", len(rs))
	}
}

func mcpCall(e *env, tok, method string, params any) (int, string) {
	return e.json("POST", "/mcp", tok, map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
}

func TestMCP(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	bob, bTok := e.user("bob@x.gr")
	e.record("projects", map[string]any{"user_id": alice.Id, "name": "Σπίτι"})
	_, out := e.upload(aTok, map[string]string{"user_id": alice.Id, "tags": `["wood"]`, "note": "ξύλινη πέργκολα"})
	var a struct{ Id string }
	_ = json.Unmarshal([]byte(out), &a)
	_, _ = e.upload(bTok, map[string]string{"user_id": bob.Id, "tags": `["wood"]`, "note": "bob secret"})

	if code, _ := mcpCall(e, "", "tools/list", map[string]any{}); code != 401 {
		t.Fatalf("mcp without token: want 401, got %d", code)
	}
	code, out := mcpCall(e, aTok, "tools/list", map[string]any{})
	for _, name := range []string{"list_projects", "search_inspirations", "get_inspiration", "save_inspiration", "add_note"} {
		if code != 200 || !strings.Contains(out, name) {
			t.Fatalf("tools/list missing %s: %d %s", name, code, out)
		}
	}
	_, out = mcpCall(e, aTok, "tools/call", map[string]any{"name": "search_inspirations", "arguments": map[string]any{"tags": []string{"wood"}}})
	if !strings.Contains(out, "πέργκολα") || strings.Contains(out, "bob secret") {
		t.Fatalf("search leaks or misses: %s", out)
	}
	_, out = mcpCall(e, aTok, "tools/call", map[string]any{"name": "search_inspirations", "arguments": map[string]any{"query": "πέργκολα"}})
	if !strings.Contains(out, a.Id) {
		t.Fatalf("text search misses: %s", out)
	}
	_, out = mcpCall(e, aTok, "tools/call", map[string]any{"name": "list_projects", "arguments": map[string]any{}})
	if !strings.Contains(out, "Σπίτι") {
		t.Fatalf("list_projects: %s", out)
	}
	_, out = mcpCall(e, aTok, "tools/call", map[string]any{"name": "get_inspiration", "arguments": map[string]any{"id": a.Id}})
	if !strings.Contains(out, `"type":"image"`) || !strings.Contains(out, "image_url") {
		t.Fatalf("get_inspiration: %s", out)
	}
	_, out = mcpCall(e, bTok, "tools/call", map[string]any{"name": "get_inspiration", "arguments": map[string]any{"id": a.Id}})
	if !strings.Contains(out, `"isError":true`) {
		t.Fatalf("bob gets alice's inspiration: %s", out)
	}
	_, out = mcpCall(e, aTok, "tools/call", map[string]any{"name": "add_note", "arguments": map[string]any{"id": a.Id, "text": "ακόμα"}})
	if !strings.Contains(out, "ακόμα") {
		t.Fatalf("add_note: %s", out)
	}
	_, out = mcpCall(e, aTok, "tools/call", map[string]any{"name": "save_inspiration", "arguments": map[string]any{"image_url": "https://127.0.0.1/a.png"}})
	if !strings.Contains(out, `"isError":true`) {
		t.Fatalf("save from loopback must fail: %s", out)
	}
}

func TestIsPublicAddr(t *testing.T) {
	for ip, want := range map[string]bool{
		"8.8.8.8": true, "2606:4700::1111": true,
		"127.0.0.1": false, "10.1.2.3": false, "192.168.1.1": false, "172.16.0.1": false, "169.254.169.254": false,
		"100.64.0.1": false, "0.0.0.0": false, "::1": false, "::": false, "fe80::1": false, "fc00::1": false,
		"::ffff:127.0.0.1": false, "64:ff9b::7f00:1": false, "64:ff9b::808:808": true, "224.0.0.1": false,
	} {
		if got := mb.IsPublicAddr(netip.MustParseAddr(ip)); got != want {
			t.Errorf("IsPublicAddr(%s) = %v, want %v", ip, got, want)
		}
	}
}

func TestImportKeepsIdsAndPassword(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "files"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "files", "x.png"), png1x1, 0o644)
	hash, _ := bcrypt.GenerateFromPassword([]byte("secret-pass"), 10)
	uid, pid, iid := "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"
	ex := map[string]any{
		"users":         []map[string]any{{"id": uid, "email": "h@x.gr", "password_hash": string(hash)}},
		"projects":      []map[string]any{{"id": pid, "user_id": uid, "name": "P", "description": "", "created_at": "2026-11-01T10:00:00.123+00:00"}},
		"inspirations":  []map[string]any{{"id": iid, "user_id": uid, "project_id": pid, "file": "files/x.png", "note": "n", "tags": []string{"wood"}, "level": "detail", "regions": []any{map[string]any{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "note": "r"}}, "created_at": "2026-11-02T10:00:00+00:00"}},
		"map_positions": []map[string]any{{"user_id": uid, "scope": pid, "node_key": "i:" + iid, "x": 1.5, "y": 2}},
	}
	b, _ := json.Marshal(ex)
	_ = os.WriteFile(filepath.Join(dir, "export.json"), b, 0o644)
	if err := mb.Import(e.app, dir); err != nil {
		t.Fatal(err)
	}
	r, err := e.app.FindRecordById("inspirations", iid)
	if err != nil || r.GetString("project_id") != pid || r.GetString("image") == "" || !strings.HasPrefix(r.GetString("created_at"), "2026-11-02") {
		t.Fatalf("inspiration not imported right: %v %v", err, r)
	}
	if r.GetString("level") != e.levelID(r.GetString("user_id"), "Λεπτομέρεια") {
		t.Fatalf("imported level key detail not mapped to the user's level: %q", r.GetString("level"))
	}
	code, out := e.json("POST", "/api/collections/users/auth-with-password", "", map[string]any{"identity": "h@x.gr", "password": "secret-pass"})
	if code != 200 {
		t.Fatalf("login with imported hash: %d %s", code, out)
	}
	var auth struct{ Token string }
	_ = json.Unmarshal([]byte(out), &auth)
	if code, out := e.req("GET", "/api/collections/inspirations/records/"+iid, auth.Token, nil, ""); code != 200 {
		t.Fatalf("imported row not readable by its owner: %d %s", code, out)
	}
}

func TestMCPSuggestLabels(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	_, bTok := e.user("bob@x.gr")
	id := func(out string) string {
		var r struct{ Id string }
		_ = json.Unmarshal([]byte(out), &r)
		return r.Id
	}
	_, out := e.upload(aTok, map[string]string{"user_id": alice.Id, "note": "bare"})
	bare := id(out)
	_, out = e.upload(aTok, map[string]string{"user_id": alice.Id, "tags": `["wood"]`, "level": e.levelID(alice.Id, "Λεπτομέρεια"), "note": "done"})
	done := id(out)

	call := func(tok, name string, args map[string]any) string {
		_, out := mcpCall(e, tok, "tools/call", map[string]any{"name": name, "arguments": args})
		return out
	}
	out = call(aTok, "search_inspirations", map[string]any{"unlabeled": true})
	if !strings.Contains(out, bare) || strings.Contains(out, done) {
		t.Fatalf("unlabeled filter: %s", out)
	}
	if out = call(aTok, "suggest_labels", map[string]any{"id": bare, "level": "huge"}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("invalid level accepted: %s", out)
	}
	if out = call(aTok, "suggest_labels", map[string]any{"id": bare}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("empty suggestion accepted: %s", out)
	}
	if out = call(bTok, "suggest_labels", map[string]any{"id": bare, "tags": []string{"x"}}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("bob can suggest on alice's row: %s", out)
	}
	if out = call(aTok, "suggest_labels", map[string]any{"id": bare, "level": "κτίριο", "tags": []string{" Ξύλο ", "ξύλο", "φως"}}); strings.Contains(out, `"isError":true`) {
		t.Fatalf("suggest_labels: %s", out)
	}
	r, _ := e.app.FindRecordById("inspirations", bare)
	if r.GetString("level") != "" || len(r.GetStringSlice("tags")) != 0 {
		t.Fatalf("suggestion must not change level/tags: %q %v", r.GetString("level"), r.Get("tags"))
	}
	var s struct {
		Level string   `json:"level"`
		Tags  []string `json:"tags"`
	}
	if err := r.UnmarshalJSONField("suggestion", &s); err != nil || s.Level != e.levelID(alice.Id, "Κτίριο") || strings.Join(s.Tags, ",") != "ξύλο,φως" {
		t.Fatalf("stored suggestion: %+v %v", s, err)
	}
	// A pending suggestion takes the row off the unlabeled list, so the AI does not redo it.
	if out = call(aTok, "search_inspirations", map[string]any{"unlabeled": true}); strings.Contains(out, bare) {
		t.Fatalf("pending row still unlabeled: %s", out)
	}
}
