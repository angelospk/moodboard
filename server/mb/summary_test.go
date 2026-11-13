package mb_test

import (
	"encoding/json"
	"image/color"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"moodboard/server/mb"
)

const goodDraft = `{"parts":[{"text":"Ένα project για "},{"choices":["μινιμαλιστικά σπίτια","ξύλινα καταφύγια"]},{"text":" με φυσικό φως."}]}`

type draftReply struct {
	Enabled *bool `json:"enabled"`
	Parts   []struct {
		Text    string   `json:"text"`
		Choices []string `json:"choices"`
	} `json:"parts"`
}

// summaryProject makes Alice a project with n images (Bob has one with a secret tag).
func summaryProject(t *testing.T, f *fakeGemini, n int, limit int) (e *env, alice, tok, project string) {
	t.Helper()
	e, _ = aiEnv(t, f, limit)
	a, aTok := e.user("alice@x.gr")
	b, bTok := e.user("bob@x.gr")
	project = e.record("projects", map[string]any{"user_id": a.Id, "name": "Λιμάνι", "description": "παλιά αποθήκες"}).Id
	for i := 0; i < n; i++ {
		fields := map[string]string{"user_id": a.Id, "project_id": project, "tags": `["beton"]`}
		if i == 0 {
			fields["note"] = "ωραίο ρυθμό ανοιγμάτων"
		}
		e.uploadImage(aTok, fields, solid(16, 16, color.RGBA{uint8(i * 20), 100, 50, 255}))
	}
	bp := e.record("projects", map[string]any{"user_id": b.Id, "name": "Bobs"}).Id
	e.uploadImage(bTok, map[string]string{"user_id": b.Id, "project_id": bp, "tags": `["bobsecret"]`, "note": "bobnote"}, solid(16, 16, red))
	e.setAI(a.Id, true) // after the uploads: the labeler must not spend the budget on them
	return e, a.Id, aTok, project
}

func draft(e *env, tok, project, lang string) (int, string) {
	r := httptest.NewRequest("POST", "/api/mb/projects/"+project+"/summary-draft", nil)
	r.Header.Set("Authorization", tok)
	r.Header.Set("Accept-Language", lang)
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func TestSummaryDraftSendsAProjectSampleAndReturnsChoices(t *testing.T) {
	f := newFakeGemini(t, goodDraft)
	e, _, tok, project := summaryProject(t, f, 12, 100)
	before := f.count()

	code, out := draft(e, tok, project, "el")
	if code != 200 {
		t.Fatalf("%d %s", code, out)
	}
	var d draftReply
	_ = json.Unmarshal([]byte(out), &d)
	if len(d.Parts) != 3 || d.Parts[0].Text != "Ένα project για " || len(d.Parts[1].Choices) != 2 || d.Parts[1].Text != "" {
		t.Fatalf("parts: %s", out)
	}
	if f.count() != before+1 {
		t.Fatalf("one model call, got %d", f.count()-before)
	}
	call := f.calls[len(f.calls)-1]
	if !strings.HasSuffix(call.path, ":generateContent") {
		t.Fatalf("path %s", call.path)
	}
	if n := strings.Count(call.body, `"inline_data"`); n != 8 {
		t.Fatalf("12 images in the project: want a sample of 8, got %d", n)
	}
	for _, want := range []string{"Λιμάνι", "παλιά αποθήκες", "beton", "ωραίο ρυθμό ανοιγμάτων", "Greek"} {
		if !strings.Contains(call.body, want) {
			t.Fatalf("prompt lacks %q", want)
		}
	}
	for _, leak := range []string{"bobsecret", "bobnote", "Bobs"} {
		if strings.Contains(call.body, leak) {
			t.Fatalf("another user's %q reached the prompt", leak)
		}
	}
}

func TestSummaryDraftAsksInEnglishWhenTheAppIsEnglish(t *testing.T) {
	f := newFakeGemini(t, goodDraft)
	e, _, tok, project := summaryProject(t, f, 2, 100)
	if code, out := draft(e, tok, project, "en"); code != 200 {
		t.Fatalf("%d %s", code, out)
	}
	if !strings.Contains(f.calls[len(f.calls)-1].body, "English") {
		t.Fatal("the prompt must ask for English")
	}
}

func TestSummaryDraftRefusals(t *testing.T) {
	f := newFakeGemini(t, goodDraft)
	e, alice, tok, project := summaryProject(t, f, 2, 100)
	_, bTok := e.user("carol@x.gr")
	before := f.count()

	if code, _ := draft(e, bTok, project, "el"); code != 404 {
		t.Fatalf("someone else's project: %d", code)
	}
	if code, _ := draft(e, tok, "nope", "el"); code != 404 {
		t.Fatalf("unknown project: %d", code)
	}
	empty := e.record("projects", map[string]any{"user_id": alice, "name": "Άδειο"}).Id
	if code, _ := draft(e, tok, empty, "el"); code != 400 {
		t.Fatalf("empty project: %d", code)
	}
	if code, _ := draft(e, "", project, "el"); code != 401 && code != 403 && code != 404 {
		t.Fatalf("no token: %d", code)
	}
	if f.count() != before {
		t.Fatalf("a refused request called the model: %d", f.count()-before)
	}
}

func TestSummaryDraftNeedsConsent(t *testing.T) {
	f := newFakeGemini(t, goodDraft)
	e, alice, tok, project := summaryProject(t, f, 2, 100)
	e.setAI(alice, false)
	before := f.count()
	code, out := draft(e, tok, project, "el")
	var d draftReply
	_ = json.Unmarshal([]byte(out), &d)
	if code != 200 || d.Enabled == nil || *d.Enabled || f.count() != before {
		t.Fatalf("%d %s calls %d", code, out, f.count()-before)
	}
	// The embedding consent also covers sending the images.
	e.setEmbed(alice, true)
	if code, _ := draft(e, tok, project, "el"); code != 200 || f.count() != before+1 {
		t.Fatalf("embed consent: %d, calls %d", code, f.count()-before)
	}
}

func TestSummaryDraftRejectsAnInvalidAnswer(t *testing.T) {
	for name, reply := range map[string]string{
		"one choice only": `{"parts":[{"choices":["only one"]}]}`,
		"both fields":     `{"parts":[{"text":"x","choices":["a","b"]}]}`,
		"no parts":        `{"parts":[]}`,
		"not json":        `Ένα project`,
		"too many":        `{"parts":[{"choices":["a","b","c","d"]}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeGemini(t, reply)
			e, _, tok, project := summaryProject(t, f, 2, 100)
			if code, out := draft(e, tok, project, "el"); code != 502 {
				t.Fatalf("want 502, got %d %s", code, out)
			}
		})
	}
}

// The live model sometimes puts a lone space between two choices or adds an empty part. Both are
// harmless; the draft must still arrive, with the space kept so the sentence reads right.
func TestSummaryDraftAcceptsSpacesAndEmptyParts(t *testing.T) {
	f := newFakeGemini(t, `{"parts":[{"choices":["a","b"]},{"text":" "},{"choices":["c","d"]},{"text":""},{}]}`)
	e, _, tok, project := summaryProject(t, f, 2, 100)
	code, out := draft(e, tok, project, "el")
	if code != 200 {
		t.Fatalf("want 200, got %d %s", code, out)
	}
	var d draftReply
	if err := json.Unmarshal([]byte(out), &d); err != nil {
		t.Fatal(err)
	}
	if len(d.Parts) != 3 || d.Parts[1].Text != " " {
		t.Fatalf("want 3 parts with the space kept, got %+v", d.Parts)
	}
}

func TestSummaryDraftCountsAgainstTheDailyBudget(t *testing.T) {
	f := newFakeGemini(t, goodDraft)
	e, _, tok, project := summaryProject(t, f, 2, 2)
	for i := 1; i <= 2; i++ {
		if code, out := draft(e, tok, project, "el"); code != 200 {
			t.Fatalf("draft %d: %d %s", i, code, out)
		}
	}
	before := f.count()
	if code, _ := draft(e, tok, project, "el"); code != http.StatusTooManyRequests || f.count() != before {
		t.Fatalf("third draft: want 429 and no call, got %d (%d calls)", code, f.count()-before)
	}
}

func TestPickDiverse(t *testing.T) {
	// Two near-identical reds, one blue, one green: three picks must cover all three colors.
	vecs := [][]float32{{1, 0, 0}, {0.99, 0.14, 0}, {0, 0, 1}, {0, 1, 0}}
	got := mb.PickDiverse(vecs, 3)
	seen := map[int]bool{}
	for _, i := range got {
		seen[i] = true
	}
	if len(got) != 3 || got[0] != 0 || !seen[2] || !seen[3] {
		t.Fatalf("got %v, want the first, then blue and green", got)
	}
	if got := mb.PickDiverse(vecs, 10); len(got) != 4 {
		t.Fatalf("k above n: %v", got)
	}
	if got := mb.PickDiverse(nil, 3); len(got) != 0 {
		t.Fatalf("empty: %v", got)
	}
}
