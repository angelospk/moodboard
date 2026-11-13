package mb_test

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// shareFixture: alice owns boards A and B (one image each, plus one in no project); bob is another user.
type shareFixture struct {
	e                *env
	aTok, bTok       string
	projA, projB     string
	insA, insB, insX string
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
	f.insA = id(map[string]string{"user_id": alice.Id, "project_id": pa.Id, "note": "φως Α", "tags": `["ξύλο"]`, "level": e.levelID(alice.Id, "Λεπτομέρεια"),
		"source_url": "https://site.example/a", "source_title": "Σελίδα Α", "regions": `[{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"note":"γωνία"}]`})
	f.insB = id(map[string]string{"user_id": alice.Id, "project_id": pb.Id, "note": "κρυφό Β"})
	f.insX = id(map[string]string{"user_id": alice.Id, "note": "χωρίς project"})
	return f
}

// set changes board A's share settings through the normal projects API, as the owner.
func (f *shareFixture) set(t *testing.T, fields map[string]any) {
	t.Helper()
	if code, out := f.e.json("PATCH", "/api/collections/projects/records/"+f.projA, f.aTok, fields); code != 200 {
		t.Fatalf("patch project: %d %s", code, out)
	}
}

func (f *shareFixture) view(t *testing.T, want int) string {
	t.Helper()
	code, out := f.e.req("GET", "/api/mb/public/"+f.projA, "", nil, "")
	if code != want {
		t.Fatalf("public view: want %d, got %d %s", want, code, out)
	}
	return out
}

func mustHave(t *testing.T, out string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(out, w) {
			t.Fatalf("missing %q: %s", w, out)
		}
	}
}

func mustLack(t *testing.T, out string, leak ...string) {
	t.Helper()
	for _, l := range leak {
		if strings.Contains(out, l) {
			t.Fatalf("leaks %q: %s", l, out)
		}
	}
}

func TestPublicBoardOffByDefault(t *testing.T) {
	f := newShareFixture(t)
	f.view(t, 404)
	if code, _ := f.e.req("GET", "/api/mb/public/"+f.projA+"/files/"+f.insA, "", nil, ""); code != 404 {
		t.Fatalf("image of a private board: want 404, got %d", code)
	}
	// The generic API stays owner-only.
	if code, _ := f.e.req("GET", "/api/collections/projects/records/"+f.projA, "", nil, ""); code != 404 {
		t.Fatalf("anonymous project read: %d", code)
	}
}

func TestPublicBoardDefaults(t *testing.T) {
	f := newShareFixture(t)
	e := f.e
	if code, out := e.json("POST", "/api/mb/positions", f.aTok, map[string]any{"scope": f.projA, "positions": []map[string]any{
		{"key": "i:" + f.insA, "x": 10, "y": 20}, {"key": "i:" + f.insX, "x": 3, "y": 4}, {"key": "t:παλιό-μυστικό", "x": 5, "y": 6}, {"key": "t:ξύλο", "x": 7, "y": 8}}}); code != 204 {
		t.Fatalf("save positions: %d %s", code, out)
	}
	f.set(t, map[string]any{"public": true})
	out := f.view(t, 200)
	// Defaults: notes, region notes, tags and level shown; sources hidden.
	mustHave(t, out, "Σπίτι Α", "περιγραφή", "φως Α", "γωνία", "ξύλο", "Λεπτομέρεια", f.insA, `"x":10`, `"t:ξύλο"`)
	mustLack(t, out, "site.example", "Σελίδα Α", "Μυστικό Β", "κρυφό Β", f.insB, f.insX, "χωρίς project", "παλιό-μυστικό",
		"alice@x.gr", "user_id", f.projB)

	// Images of this board only; thumbnails work; browsers may reuse them for 5 minutes.
	for _, u := range []string{"/api/mb/public/" + f.projA + "/files/" + f.insA, "/api/mb/public/" + f.projA + "/files/" + f.insA + "?thumb=480x0"} {
		w := e.raw("GET", u)
		if w.Code != 200 || !strings.HasPrefix(w.Body.String(), "\x89PNG") {
			t.Fatalf("%s: want png, got %d", u, w.Code)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "private, max-age=300" {
			t.Fatalf("image Cache-Control %q", cc)
		}
	}
	for _, other := range []string{f.insB, f.insX, "nonexistent123"} {
		if code, _ := e.req("GET", "/api/mb/public/"+f.projA+"/files/"+other, "", nil, ""); code != 404 {
			t.Fatalf("board A serves image %s: want 404, got %d", other, code)
		}
	}
	// Board B stays private; its image is not reachable through board A or B.
	if code, _ := e.req("GET", "/api/mb/public/"+f.projB, "", nil, ""); code != 404 {
		t.Fatalf("private board B: %d", code)
	}
	if code, _ := e.req("GET", "/api/mb/public/"+f.projB+"/files/"+f.insB, "", nil, ""); code != 404 {
		t.Fatalf("image of private board B: %d", code)
	}
	// The protected file stays protected through the normal file route.
	rec, _ := e.app.FindRecordById("inspirations", f.insA)
	if code, _ := e.req("GET", "/api/files/inspirations/"+f.insA+"/"+rec.GetString("image"), "", nil, ""); code < 400 {
		t.Fatalf("protected file served without a file token: %d", code)
	}
}

func TestPublicBoardOptions(t *testing.T) {
	f := newShareFixture(t)
	_, _ = f.e.json("POST", "/api/mb/positions", f.aTok, map[string]any{"scope": f.projA, "positions": []map[string]any{{"key": "t:ξύλο", "x": 7, "y": 8}}})
	f.set(t, map[string]any{"public": true, "share_hide_notes": true, "share_hide_regions": true, "share_hide_tags": true, "share_show_sources": true})
	out := f.view(t, 200)
	mustHave(t, out, "Σπίτι Α", f.insA, "https://site.example/a", "Σελίδα Α")
	mustLack(t, out, "φως Α", "γωνία", "ξύλο", "Λεπτομέρεια")
	// Turning it off stops the view and the images at once.
	f.set(t, map[string]any{"public": false})
	f.view(t, 404)
	if code, _ := f.e.req("GET", "/api/mb/public/"+f.projA+"/files/"+f.insA, "", nil, ""); code != 404 {
		t.Fatalf("image after turning public off: %d", code)
	}
}

func TestPublicBoardOwnershipAndNoWrite(t *testing.T) {
	f := newShareFixture(t)
	e := f.e
	// Only the owner can make a board public.
	if code, _ := e.json("PATCH", "/api/collections/projects/records/"+f.projA, f.bTok, map[string]any{"public": true}); code != 404 {
		t.Fatalf("bob makes alice's board public: want 404, got %d", code)
	}
	if code, _ := e.json("PATCH", "/api/collections/projects/records/"+f.projA, "", map[string]any{"public": true}); code < 400 {
		t.Fatalf("anonymous makes a board public: %d", code)
	}
	f.view(t, 404)

	f.set(t, map[string]any{"public": true})
	base := "/api/mb/public/" + f.projA
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, u := range []string{base, base + "/files/" + f.insA} {
			if code, _ := e.json(m, u, "", map[string]any{"note": "x"}); code != 404 && code != 405 {
				t.Fatalf("%s %s: want 404/405, got %d", m, u, code)
			}
		}
	}
	// A public board does not open its rows to the generic API.
	if code, out := e.req("GET", "/api/collections/inspirations/records", "", nil, ""); code == 200 && !strings.Contains(out, `"totalItems":0`) {
		t.Fatalf("anonymous list: %s", out)
	}
	if code, _ := e.json("PATCH", "/api/collections/inspirations/records/"+f.insA, "", map[string]any{"note": "x"}); code < 400 {
		t.Fatalf("anonymous write: %d", code)
	}
	rec, _ := e.app.FindRecordById("inspirations", f.insA)
	if rec.GetString("note") != "φως Α" {
		t.Fatal("note changed")
	}
	for _, u := range []string{"/api/mb/public/", "/api/mb/public/nonexistent123", "/api/mb/public/nonexistent123/files/" + f.insA} {
		if code, _ := e.req("GET", u, "", nil, ""); code != 404 {
			t.Fatalf("%s: want 404, got %d", u, code)
		}
	}
}

func (e *env) raw(method, url string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, httptest.NewRequest(method, url, nil))
	return w
}

// Images also live in a public bucket under /mbinspirations/<id>/<stored file name>. A viewer of a
// public board must never learn the stored file name, or they could bypass the metadata cleaning
// and keep the link after the board goes private.
func TestPublicBoardNeverRevealsStoredFileName(t *testing.T) {
	f := newShareFixture(t)
	e := f.e
	rec, err := e.app.FindRecordById("inspirations", f.insA)
	if err != nil {
		t.Fatal(err)
	}
	stored := rec.GetString("image")
	if stored == "" {
		t.Fatal("fixture image has no stored name")
	}
	f.set(t, map[string]any{"public": true})
	mustLack(t, f.view(t, 200), stored, "mbinspirations")
	for _, u := range []string{
		"/api/mb/public/" + f.projA + "/files/" + f.insA,
		"/api/mb/public/" + f.projA + "/files/" + f.insA + "?thumb=480x0",
	} {
		w := e.raw("GET", u)
		if w.Code != 200 {
			t.Fatalf("%s: %d", u, w.Code)
		}
		for k, vs := range w.Header() {
			for _, v := range vs {
				if strings.Contains(v, stored) || strings.Contains(v, "480x0_") {
					t.Fatalf("%s: header %s leaks the stored name: %q", u, k, v)
				}
			}
		}
	}
}
