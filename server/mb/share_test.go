package mb_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// shareFixture: alice owns boards A and B (one image each); bob is another user.
type shareFixture struct {
	e                *env
	aTok, bTok       string
	projA, projB     string
	insA, insB, insX string // insX: alice's image in no project
}

func newShareFixture(t *testing.T) *shareFixture {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	_, bTok := e.user("bob@x.gr")
	pa := e.record("projects", map[string]any{"user_id": alice.Id, "name": "Σπίτι Α", "description": "περιγραφή"})
	pb := e.record("projects", map[string]any{"user_id": alice.Id, "name": "Μυστικό Β"})
	id := func(fields map[string]string) string {
		code, out := e.upload(aTok, fields)
		if code != 200 {
			t.Fatalf("upload: %d %s", code, out)
		}
		var r struct{ Id string }
		_ = json.Unmarshal([]byte(out), &r)
		return r.Id
	}
	f := &shareFixture{e: e, aTok: aTok, bTok: bTok, projA: pa.Id, projB: pb.Id}
	f.insA = id(map[string]string{"user_id": alice.Id, "project_id": pa.Id, "note": "φως Α", "tags": `["ξύλο"]`,
		"source_url": "https://private.example/a", "regions": `[{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"note":"γωνία"}]`})
	f.insB = id(map[string]string{"user_id": alice.Id, "project_id": pb.Id, "note": "κρυφό Β"})
	f.insX = id(map[string]string{"user_id": alice.Id, "note": "χωρίς project"})
	return f
}

func (f *shareFixture) create(tok, project string) (int, string) {
	return f.e.json("POST", "/api/mb/projects/"+project+"/share", tok, map[string]any{})
}

func (f *shareFixture) token(t *testing.T, project string) string {
	t.Helper()
	code, out := f.create(f.aTok, project)
	if code != 200 {
		t.Fatalf("create share: %d %s", code, out)
	}
	var r struct{ Token string }
	_ = json.Unmarshal([]byte(out), &r)
	if len(r.Token) < 43 { // 32 random bytes, base64url
		t.Fatalf("token too short: %q", r.Token)
	}
	return r.Token
}

func TestShareReadOnlyView(t *testing.T) {
	f := newShareFixture(t)
	e := f.e
	// Alice saved a layout for board A (and one for B, which must not leak).
	if code, out := e.json("POST", "/api/mb/positions", f.aTok, map[string]any{"scope": f.projA, "positions": []map[string]any{{"key": "i:" + f.insA, "x": 10, "y": 20}}}); code != 204 {
		t.Fatalf("save positions: %d %s", code, out)
	}
	_, _ = e.json("POST", "/api/mb/positions", f.aTok, map[string]any{"scope": f.projB, "positions": []map[string]any{{"key": "i:" + f.insB, "x": 1, "y": 2}}})

	tok := f.token(t, f.projA)
	code, out := e.req("GET", "/api/mb/shared/"+tok, "", nil, "")
	if code != 200 {
		t.Fatalf("anonymous view: %d %s", code, out)
	}
	for _, want := range []string{"Σπίτι Α", "φως Α", "ξύλο", "γωνία", f.insA, `"x":10`} {
		if !strings.Contains(out, want) {
			t.Fatalf("shared view lacks %q: %s", want, out)
		}
	}
	for _, leak := range []string{"Μυστικό Β", "κρυφό Β", f.insB, f.insX, "χωρίς project", "alice@x.gr", "user_id", "private.example", f.projB} {
		if strings.Contains(out, leak) {
			t.Fatalf("shared view leaks %q: %s", leak, out)
		}
	}

	// Images: only board A's, through the token; thumbnails work.
	for _, u := range []string{"/api/mb/shared/" + tok + "/files/" + f.insA, "/api/mb/shared/" + tok + "/files/" + f.insA + "?thumb=480x0"} {
		if code, body := e.req("GET", u, "", nil, ""); code != 200 || !strings.HasPrefix(body, "\x89PNG") {
			t.Fatalf("%s: want png, got %d %.60q", u, code, body)
		}
	}
	for _, other := range []string{f.insB, f.insX, "nonexistent123"} {
		if code, _ := e.req("GET", "/api/mb/shared/"+tok+"/files/"+other, "", nil, ""); code != 404 {
			t.Fatalf("token of A reads image %s: want 404, got %d", other, code)
		}
	}
	// The protected file stays protected through the normal file route.
	rec, _ := e.app.FindRecordById("inspirations", f.insA)
	if code, _ := e.req("GET", "/api/files/inspirations/"+f.insA+"/"+rec.GetString("image"), "", nil, ""); code < 400 {
		t.Fatalf("protected file served without a file token: %d", code)
	}
}

func TestShareTokenIsStoredHashedAndScoped(t *testing.T) {
	f := newShareFixture(t)
	e := f.e
	tok := f.token(t, f.projA)
	rs, err := e.app.FindAllRecords("shares")
	if err != nil || len(rs) != 1 {
		t.Fatalf("shares: %v %d", err, len(rs))
	}
	raw, _ := json.Marshal(rs[0])
	if strings.Contains(string(raw), tok) {
		t.Fatalf("raw token stored: %s", raw)
	}
	// Collection is not reachable through the generic API, with or without a session.
	for _, auth := range []string{"", f.aTok, f.bTok} {
		code, out := e.req("GET", "/api/collections/shares/records", auth, nil, "")
		if code == 200 && !strings.Contains(out, `"totalItems":0`) {
			t.Fatalf("shares listed via API: %d %s", code, out)
		}
		if code, _ := e.json("POST", "/api/collections/shares/records", auth, map[string]any{"project_id": f.projB, "token_hash": "x"}); code < 400 {
			t.Fatalf("shares created via API: %d", code)
		}
	}
	// The share token is not an auth token.
	if code, out := e.req("GET", "/api/collections/inspirations/records", tok, nil, ""); code == 200 && !strings.Contains(out, `"totalItems":0`) {
		t.Fatalf("share token used as auth: %s", out)
	}
	if code, _ := e.req("GET", "/api/mb/tags", "Bearer "+tok, nil, ""); code != 401 {
		t.Fatalf("share token used as auth on /api/mb: %d", code)
	}
}

func TestShareNoWritePath(t *testing.T) {
	f := newShareFixture(t)
	e := f.e
	tok := f.token(t, f.projA)
	base := "/api/mb/shared/" + tok
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, u := range []string{base, base + "/files/" + f.insA} {
			if code, _ := e.json(m, u, "", map[string]any{"note": "x"}); code != 404 && code != 405 {
				t.Fatalf("%s %s: want 404/405, got %d", m, u, code)
			}
		}
	}
	rec, _ := e.app.FindRecordById("inspirations", f.insA)
	if rec.GetString("note") != "φως Α" {
		t.Fatal("note changed")
	}
}

func TestShareOwnershipAndRevoke(t *testing.T) {
	f := newShareFixture(t)
	e := f.e
	// Only the owner manages a board's link.
	if code, _ := f.create("", f.projA); code != 401 {
		t.Fatalf("anonymous create: want 401, got %d", code)
	}
	if code, _ := f.create(f.bTok, f.projA); code != 404 {
		t.Fatalf("bob creates link for alice's board: want 404, got %d", code)
	}
	if code, _ := f.create(f.aTok, "nonexistent123"); code != 404 {
		t.Fatalf("link for missing board: want 404, got %d", code)
	}
	if code, _ := e.req("GET", "/api/mb/projects/"+f.projA+"/share", f.aTok, nil, ""); code != 200 {
		t.Fatalf("status before create: %d", code)
	}

	tok := f.token(t, f.projA)
	if code, out := e.req("GET", "/api/mb/projects/"+f.projA+"/share", f.aTok, nil, ""); code != 200 || !strings.Contains(out, `"active":true`) || strings.Contains(out, tok) {
		t.Fatalf("status: %d %s", code, out)
	}
	if code, _ := e.req("GET", "/api/mb/projects/"+f.projA+"/share", f.bTok, nil, ""); code != 404 {
		t.Fatalf("bob reads status: want 404, got %d", code)
	}
	if code, _ := e.req("DELETE", "/api/mb/projects/"+f.projA+"/share", f.bTok, nil, ""); code != 404 {
		t.Fatalf("bob revokes: want 404, got %d", code)
	}
	if code, _ := e.req("GET", "/api/mb/shared/"+tok, "", nil, ""); code != 200 {
		t.Fatalf("link died after bob's attempts: %d", code)
	}

	// A new link replaces the old one.
	tok2 := f.token(t, f.projA)
	if tok2 == tok {
		t.Fatal("same token twice")
	}
	if code, _ := e.req("GET", "/api/mb/shared/"+tok, "", nil, ""); code != 404 {
		t.Fatalf("old token after rotate: want 404, got %d", code)
	}

	// Revoke: view and images are gone.
	if code, _ := e.req("DELETE", "/api/mb/projects/"+f.projA+"/share", f.aTok, nil, ""); code != 204 {
		t.Fatalf("revoke: %d", code)
	}
	for _, u := range []string{"/api/mb/shared/" + tok2, "/api/mb/shared/" + tok2 + "/files/" + f.insA} {
		if code, _ := e.req("GET", u, "", nil, ""); code != 404 {
			t.Fatalf("%s after revoke: want 404, got %d", u, code)
		}
	}
	if code, out := e.req("GET", "/api/mb/projects/"+f.projA+"/share", f.aTok, nil, ""); code != 200 || !strings.Contains(out, `"active":false`) {
		t.Fatalf("status after revoke: %d %s", code, out)
	}

	// Anonymous without a valid token sees nothing.
	for _, u := range []string{"/api/mb/shared/", "/api/mb/shared/x", "/api/mb/shared/" + strings.Repeat("A", 43), "/api/mb/shared/" + strings.Repeat("A", 43) + "/files/" + f.insA} {
		if code, _ := e.req("GET", u, "", nil, ""); code != 404 {
			t.Fatalf("%s: want 404, got %d", u, code)
		}
	}

	// Deleting the board deletes its link.
	tok3 := f.token(t, f.projA)
	if code, _ := e.req("DELETE", "/api/collections/projects/records/"+f.projA, f.aTok, nil, ""); code != 204 {
		t.Fatalf("delete project: %d", code)
	}
	if code, _ := e.req("GET", "/api/mb/shared/"+tok3, "", nil, ""); code != 404 {
		t.Fatalf("link of deleted board: want 404, got %d", code)
	}
}
