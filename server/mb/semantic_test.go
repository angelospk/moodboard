package mb_test

import (
	"encoding/json"
	"image/color"
	"net/url"
	"strings"
	"testing"

	"moodboard/server/mb"
)

type hit struct {
	ID    string  `json:"id"`
	Score float64 `json:"score"`
}

type hits struct {
	Enabled *bool `json:"enabled"`
	Ready   *bool `json:"ready"`
	Results []hit `json:"results"`
}

func (h hits) ids() []string {
	out := make([]string, len(h.Results))
	for i, r := range h.Results {
		out[i] = r.ID
	}
	return out
}

func (e *env) get(tok, path string) (int, string) {
	e.t.Helper()
	return e.req("GET", path, tok, nil, "")
}

func (e *env) hits(tok, path string, want int) hits {
	e.t.Helper()
	code, out := e.get(tok, path)
	if code != want {
		e.t.Fatalf("GET %s: want %d, got %d %s", path, want, code, out)
	}
	var h hits
	_ = json.Unmarshal([]byte(out), &h)
	return h
}

// sem is a library of Alice's: red, orange and blue in P1, green in P2. Bob (also opted in) has a red one.
type sem struct {
	e                               *env
	emb                             *mb.Embedder
	f                               *fakeEmbed
	alice, bob                      string
	aTok, bTok                      string
	p1, p2                          string
	red, orange, blue, green, bobRd string
}

func newSem(t *testing.T, cfg mb.EmbedConfig) *sem {
	t.Helper()
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, cfg)
	a, aTok := e.user("alice@x.gr")
	b, bTok := e.user("bob@x.gr")
	e.setEmbed(a.Id, true)
	e.setEmbed(b.Id, true)
	s := &sem{e: e, emb: emb, f: f, alice: a.Id, bob: b.Id, aTok: aTok, bTok: bTok}
	s.p1 = e.record("projects", map[string]any{"user_id": a.Id, "name": "P1"}).Id
	s.p2 = e.record("projects", map[string]any{"user_id": a.Id, "name": "P2"}).Id
	up := func(tok, uid, project string, c color.RGBA) string {
		fields := map[string]string{"user_id": uid}
		if project != "" {
			fields["project_id"] = project
		}
		return e.uploadImage(tok, fields, solid(16, 16, c)).Id
	}
	s.red = up(aTok, a.Id, s.p1, red)
	s.orange = up(aTok, a.Id, s.p1, orange)
	s.blue = up(aTok, a.Id, s.p1, blue)
	s.green = up(aTok, a.Id, s.p2, green)
	s.bobRd = up(bTok, b.Id, "", red)
	e.settle(emb)
	return s
}

func TestSearchRanksByMeaningAndStaysInScope(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	q := url.QueryEscape("a red sofa")

	h := s.e.hits(s.aTok, "/api/mb/search?q="+q, 200)
	ids := h.ids()
	if h.Enabled == nil || !*h.Enabled || len(ids) != 4 || ids[0] != s.red || ids[1] != s.orange {
		t.Fatalf("want red, orange first among Alice's four, got %v", ids)
	}
	for _, id := range ids {
		if id == s.bobRd {
			t.Fatal("Bob's image leaked into Alice's search")
		}
	}
	if h.Results[0].Score < 0.99 || h.Results[0].Score <= h.Results[1].Score {
		t.Fatalf("scores: %+v", h.Results)
	}

	if got := s.e.hits(s.aTok, "/api/mb/search?limit=2&q="+q, 200).ids(); len(got) != 2 {
		t.Fatalf("limit 2: %v", got)
	}
	for _, id := range s.e.hits(s.aTok, "/api/mb/search?project="+s.p1+"&q="+q, 200).ids() {
		if id == s.green {
			t.Fatal("P2 image in a P1 search")
		}
	}
	// The query went out with the search prefix and no task_type.
	c := s.f.last()
	var body struct {
		Content struct {
			Parts []struct{ Text string } `json:"parts"`
		} `json:"content"`
	}
	_ = json.Unmarshal([]byte(c.body), &body)
	if len(body.Content.Parts) != 1 || body.Content.Parts[0].Text != "task: search result | query: a red sofa" {
		t.Fatalf("query body: %s", c.body)
	}
}

func TestSearchRefusals(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	p3 := s.e.record("projects", map[string]any{"user_id": s.bob, "name": "Bobs"}).Id
	if code, _ := s.e.get(s.aTok, "/api/mb/search"); code != 400 {
		t.Fatalf("no q: %d", code)
	}
	if code, _ := s.e.get(s.aTok, "/api/mb/search?q=red&project="+p3); code != 404 {
		t.Fatalf("other user's project: %d", code)
	}
	if code, _ := s.e.get("", "/api/mb/search?q=red"); code != 401 && code != 403 && code != 404 {
		t.Fatalf("no token: %d", code)
	}
	// A user who did not agree gets enabled:false and no API call.
	carol, cTok := s.e.user("carol@x.gr")
	_ = carol
	before := s.f.count()
	h := s.e.hits(cTok, "/api/mb/search?q=red", 200)
	if h.Enabled == nil || *h.Enabled || s.f.count() != before {
		t.Fatalf("no consent: enabled %v, calls %d -> %d", h.Enabled, before, s.f.count())
	}
}

func TestSearchQueryBudget(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{QueryLimit: 1})
	s.e.hits(s.aTok, "/api/mb/search?q=red", 200)
	if code, _ := s.e.get(s.aTok, "/api/mb/search?q=blue"); code != 429 {
		t.Fatalf("second query: want 429, got %d", code)
	}
	// Bob has his own budget.
	s.e.hits(s.bTok, "/api/mb/search?q=red", 200)
}

func TestSimilarScopes(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	base := "/api/mb/inspirations/" + s.red + "/similar"

	in := s.e.hits(s.aTok, base, 200).ids() // default: this project
	if len(in) != 2 || in[0] != s.orange || in[1] != s.blue {
		t.Fatalf("project scope: want [orange blue], got %v", in)
	}
	all := s.e.hits(s.aTok, base+"?scope=all", 200).ids()
	if len(all) != 3 || all[0] != s.orange {
		t.Fatalf("all scope: %v", all)
	}
	for _, id := range append(in, all...) {
		if id == s.red || id == s.bobRd {
			t.Fatalf("self or another user's image in %v / %v", in, all)
		}
	}
	if code, _ := s.e.get(s.bTok, base); code != 404 {
		t.Fatalf("someone else's image: %d", code)
	}
	if got := s.e.hits(s.aTok, base+"?scope=all&limit=1", 200).ids(); len(got) != 1 {
		t.Fatalf("limit: %v", got)
	}
}

func TestSimilarSaysNotReadyWithoutVector(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	c, cTok := s.e.user("carol@x.gr") // never agreed: no vector
	id := s.e.uploadImage(cTok, map[string]string{"user_id": c.Id}, solid(16, 16, red)).Id
	s.e.settle(s.emb)
	h := s.e.hits(cTok, "/api/mb/inspirations/"+id+"/similar", 200)
	if h.Ready == nil || *h.Ready || len(h.Results) != 0 {
		t.Fatalf("want ready:false, got %+v", h)
	}
}

func TestIndexFollowsChanges(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	base := "/api/mb/inspirations/" + s.red + "/similar?scope=all"
	if got := s.e.hits(s.aTok, base, 200).ids(); len(got) != 3 {
		t.Fatalf("before: %v", got)
	}
	orange, _ := s.e.app.FindRecordById("inspirations", s.orange)
	if err := s.e.app.Delete(orange); err != nil {
		t.Fatal(err)
	}
	for _, id := range s.e.hits(s.aTok, base, 200).ids() {
		if id == s.orange {
			t.Fatal("a deleted image is still found")
		}
	}
	// Moving an image to another project changes the project scope.
	blue, _ := s.e.app.FindRecordById("inspirations", s.blue)
	blue.Set("project_id", s.p2)
	if err := s.e.app.Save(blue); err != nil {
		t.Fatal(err)
	}
	if got := s.e.hits(s.aTok, "/api/mb/inspirations/"+s.red+"/similar", 200).ids(); len(got) != 0 {
		t.Fatalf("P1 now holds only red: %v", got)
	}
}

// A vector made by another model, or for an older file, must not rank next to current ones.
func TestIndexSkipsStaleVectors(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	base := "/api/mb/inspirations/" + s.blue + "/similar?scope=all"
	has := func(id string) bool {
		for _, got := range s.e.hits(s.aTok, base, 200).ids() {
			if got == id {
				return true
			}
		}
		return false
	}
	if !has(s.red) || !has(s.orange) {
		t.Fatal("setup: red and orange must be found")
	}
	f := s.e.featuresOf(s.red)
	f.Set("model", "an-older-model") // same size, other model
	if err := s.e.app.Save(f); err != nil {
		t.Fatal(err)
	}
	g := s.e.featuresOf(s.orange)
	g.Set("image", "an-older-file.png") // vector of a file that was replaced
	if err := s.e.app.Save(g); err != nil {
		t.Fatal(err)
	}
	if has(s.red) || has(s.orange) {
		t.Fatal("a stale vector is still ranked")
	}
	if !has(s.green) {
		t.Fatal("current vectors must stay")
	}
}

// A change that lands while the index is being built must not be lost to a stale index.
func TestIndexBuiltDuringAChangeIsNotCached(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	base := "/api/mb/inspirations/" + s.red + "/similar?scope=all"
	mb.SetIndexBuildHook(func() {
		mb.SetIndexBuildHook(nil)
		orange, _ := s.e.app.FindRecordById("inspirations", s.orange)
		if err := s.e.app.Delete(orange); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(func() { mb.SetIndexBuildHook(nil) })
	s.e.hits(s.aTok, base, 200) // this build raced with the delete
	for _, id := range s.e.hits(s.aTok, base, 200).ids() {
		if id == s.orange {
			t.Fatal("the stale index was cached")
		}
	}
}

type pairs struct {
	Pairs []struct {
		A        string `json:"a"`
		B        string `json:"b"`
		Distance int    `json:"distance"`
	} `json:"pairs"`
}

func TestDuplicatesByHash(t *testing.T) {
	e := newEnv(t)
	a, aTok := e.user("alice@x.gr")
	b, bTok := e.user("bob@x.gr")
	up := func(tok, uid, project string, img []byte) string {
		f := map[string]string{"user_id": uid}
		if project != "" {
			f["project_id"] = project
		}
		return e.uploadImage(tok, f, img).Id
	}
	p1 := e.record("projects", map[string]any{"user_id": a.Id, "name": "P1"}).Id
	one := up(aTok, a.Id, p1, gradient(32, 32, false))
	two := up(aTok, a.Id, "", gradient(200, 120, false)) // same picture, other size, other project
	up(aTok, a.Id, p1, gradient(32, 32, true))           // mirrored: different
	up(aTok, a.Id, p1, solid(16, 16, red))               // two flat images are not "the same picture"
	up(aTok, a.Id, p1, solid(16, 16, blue))
	up(bTok, b.Id, "", gradient(32, 32, false)) // Bob's copy never pairs with Alice's

	get := func(path string) pairs {
		code, out := e.get(aTok, path)
		if code != 200 {
			t.Fatalf("%s: %d %s", path, code, out)
		}
		var p pairs
		_ = json.Unmarshal([]byte(out), &p)
		return p
	}
	p := get("/api/mb/duplicates")
	if len(p.Pairs) != 1 {
		t.Fatalf("want one pair, got %+v", p.Pairs)
	}
	if got := map[string]bool{p.Pairs[0].A: true, p.Pairs[0].B: true}; !got[one] || !got[two] || p.Pairs[0].Distance > 6 {
		t.Fatalf("pair: %+v", p.Pairs[0])
	}
	if p := get("/api/mb/duplicates?project=" + p1); len(p.Pairs) != 0 {
		t.Fatalf("inside P1 there is no pair: %+v", p.Pairs)
	}
	if p := get("/api/mb/duplicates?id=" + one); len(p.Pairs) != 1 {
		t.Fatalf("pairs of the first image: %+v", p.Pairs)
	}
	if p := get("/api/mb/duplicates?id=nobody"); len(p.Pairs) != 0 {
		t.Fatalf("unknown id: %+v", p.Pairs)
	}
}

func TestVoteLabels(t *testing.T) {
	ns := []mb.Neighbor{
		{Score: 0.90, Level: "L1", Tags: []string{"warm", "sofa"}},
		{Score: 0.85, Level: "L1", Tags: []string{"warm"}},
		{Score: 0.30, Level: "L2", Tags: []string{"cold"}},
		{Score: 0.30, Level: "L2", Tags: []string{"cold"}},
	}
	level, tags := mb.VoteLabels(ns, nil)
	if level != "L1" {
		t.Fatalf("level %q", level)
	}
	if len(tags) != 1 || tags[0] != "warm" { // sofa has one voter; cold has two voters but little weight
		t.Fatalf("tags %v", tags)
	}
	if _, tags := mb.VoteLabels(ns, []string{"warm"}); len(tags) != 0 {
		t.Fatalf("own tags must not come back: %v", tags)
	}
	if level, tags := mb.VoteLabels(nil, nil); level != "" || len(tags) != 0 {
		t.Fatal("no neighbours, no suggestion")
	}
}

func TestKnnSuggestFromNeighbours(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	e := s.e
	l1, l2 := e.levelID(s.alice, "Κτίριο"), e.levelID(s.alice, "Υλικό")
	label := func(id string, level string, tags ...string) {
		r, _ := e.app.FindRecordById("inspirations", id)
		r.Set("level", level)
		r.Set("tags", tags)
		if err := e.app.Save(r); err != nil {
			t.Fatal(err)
		}
	}
	label(s.red, l1, "warm", "sofa")
	label(s.orange, l1, "warm")
	label(s.blue, l2, "cold")
	// Bob's image is as red as it gets, but is not Alice's: it must not vote.
	rb, _ := e.app.FindRecordById("inspirations", s.bobRd)
	rb.Set("tags", []string{"bobsecret", "bobsecret2"})
	if err := e.app.Save(rb); err != nil {
		t.Fatal(err)
	}
	fresh := e.uploadImage(s.aTok, map[string]string{"user_id": s.alice, "project_id": s.p1}, solid(16, 16, color.RGBA{255, 50, 0, 255})).Id
	e.settle(s.emb)

	code, out := e.get(s.aTok, "/api/mb/inspirations/"+fresh+"/knn-suggest")
	if code != 200 {
		t.Fatalf("%d %s", code, out)
	}
	var got struct {
		Ready bool     `json:"ready"`
		Level string   `json:"level"`
		Tags  []string `json:"tags"`
	}
	_ = json.Unmarshal([]byte(out), &got)
	if !got.Ready || got.Level != l1 || len(got.Tags) != 1 || got.Tags[0] != "warm" {
		t.Fatalf("got %s", out)
	}
	if code, _ := e.get(s.bTok, "/api/mb/inspirations/"+fresh+"/knn-suggest"); code != 404 {
		t.Fatalf("someone else's image: %d", code)
	}
}

func TestMCPSemanticTools(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	call := func(tok, name string, args map[string]any) string {
		_, out := mcpCall(s.e, tok, "tools/call", map[string]any{"name": name, "arguments": args})
		return out
	}
	out := call(s.aTok, "semantic_search", map[string]any{"query": "red sofa", "limit": 2})
	if !strings.Contains(out, s.red) || !strings.Contains(out, s.orange) || strings.Contains(out, s.blue) ||
		strings.Contains(out, s.bobRd) || strings.Contains(out, `"isError":true`) || !strings.Contains(out, "score") {
		t.Fatalf("semantic_search: %s", out)
	}
	if out = call(s.aTok, "semantic_search", map[string]any{"query": "red", "project": "nope"}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("unknown project accepted: %s", out)
	}
	if out = call(s.aTok, "semantic_search", map[string]any{"query": "  "}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("empty query accepted: %s", out)
	}
	_, cTok := s.e.user("carol@x.gr") // did not agree
	if out = call(cTok, "semantic_search", map[string]any{"query": "red"}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("no consent must be an error the AI can read: %s", out)
	}
	out = call(s.aTok, "similar_inspirations", map[string]any{"id": s.red, "scope": "all", "limit": 1})
	if !strings.Contains(out, s.orange) || strings.Contains(out, s.bobRd) || strings.Contains(out, `"isError":true`) {
		t.Fatalf("similar_inspirations: %s", out)
	}
	if out = call(s.bTok, "similar_inspirations", map[string]any{"id": s.red}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("Bob reads Alice's neighbours: %s", out)
	}
}

func TestEmbedStatus(t *testing.T) {
	s := newSem(t, mb.EmbedConfig{})
	code, out := s.e.get(s.aTok, "/api/mb/embed/status")
	var st struct {
		Enabled  bool   `json:"enabled"`
		Consent  bool   `json:"consent"`
		Total    int    `json:"total"`
		Embedded int    `json:"embedded"`
		Model    string `json:"model"`
		Dim      int    `json:"dim"`
	}
	_ = json.Unmarshal([]byte(out), &st)
	if code != 200 || !st.Enabled || !st.Consent || st.Total != 4 || st.Embedded != 4 || st.Model != "embed-test" || st.Dim != testDim {
		t.Fatalf("%d %s", code, out)
	}
	_, cTok := s.e.user("carol@x.gr")
	_, out = s.e.get(cTok, "/api/mb/embed/status")
	_ = json.Unmarshal([]byte(out), &st)
	if !st.Enabled || st.Consent || st.Total != 0 {
		t.Fatalf("no consent: %s", out)
	}
}
