package mb_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"moodboard/server/mb"
)

// fakeGemini stands in for generativelanguage.googleapis.com. It records each request and answers
// with the next status in `statuses` (200 when the list is empty) and the body in `reply`.
type fakeGemini struct {
	srv      *httptest.Server
	mu       sync.Mutex
	calls    []geminiCall
	statuses []int
	reply    string
}

type geminiCall struct {
	path, key, body string
}

func newFakeGemini(t *testing.T, reply string) *fakeGemini {
	t.Helper()
	f := &fakeGemini{reply: reply}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.calls = append(f.calls, geminiCall{r.URL.Path, r.Header.Get("x-goog-api-key"), string(b)})
		status := 200
		if len(f.statuses) > 0 {
			status, f.statuses = f.statuses[0], f.statuses[1:]
		}
		reply := f.reply
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != 200 {
			_, _ = w.Write([]byte(`{"error":{"message":"fake failure"}}`))
			return
		}
		out, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{
			"content": map[string]any{"parts": []any{map[string]any{"text": reply}}},
		}}})
		_, _ = w.Write(out)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGemini) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func aiEnv(t *testing.T, f *fakeGemini, limit int) (*env, *mb.Labeler) {
	t.Helper()
	e := newEnv(t)
	l := mb.EnableAI(e.app, mb.AIConfig{Key: "test-key", Model: "gemini-test", BaseURL: f.srv.URL, DailyLimit: limit})
	return e, l
}

func (e *env) setAI(uid string, on bool) {
	e.t.Helper()
	u, err := e.app.FindRecordById("users", uid)
	if err != nil {
		e.t.Fatal(err)
	}
	u.Set("ai_enabled", on)
	if err := e.app.Save(u); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) newInspiration(tok string, fields map[string]string) string {
	e.t.Helper()
	code, out := e.upload(tok, fields)
	if code != 200 {
		e.t.Fatalf("upload: %d %s", code, out)
	}
	var r struct{ Id string }
	_ = json.Unmarshal([]byte(out), &r)
	return r.Id
}

// suggestionOf returns the stored suggestion, or nil when there is none.
func (e *env) suggestionOf(id string) *struct {
	Level string   `json:"level"`
	Tags  []string `json:"tags"`
} {
	e.t.Helper()
	r, err := e.app.FindRecordById("inspirations", id)
	if err != nil {
		e.t.Fatal(err)
	}
	var s struct {
		Level string   `json:"level"`
		Tags  []string `json:"tags"`
	}
	if err := r.UnmarshalJSONField("suggestion", &s); err != nil || (s.Level == "" && len(s.Tags) == 0) {
		return nil
	}
	return &s
}

const goodReply = `{"level":"Κτίριο","tags":["Ξύλο","φως"]}`

func TestAISuggestsLabelsForOptedInUser(t *testing.T) {
	f := newFakeGemini(t, goodReply)
	e, l := aiEnv(t, f, 100)
	alice, aTok := e.user("alice@x.gr")
	bob, bTok := e.user("bob@x.gr")
	e.setAI(alice.Id, true)
	// Bob's levels and tags must never reach the prompt of Alice's image.
	e.newInspiration(bTok, map[string]string{"user_id": bob.Id, "tags": `["bobsecret"]`, "level": e.levelID(bob.Id, "Υλικό")})
	e.newInspiration(aTok, map[string]string{"user_id": alice.Id, "tags": `["beton"]`, "level": e.levelID(alice.Id, "Υλικό")})
	l.Wait()
	before := f.count()

	id := e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()

	if f.count() != before+1 {
		t.Fatalf("want one Gemini call for the new image, got %d", f.count()-before)
	}
	call := f.calls[len(f.calls)-1]
	if call.path != "/v1beta/models/gemini-test:generateContent" {
		t.Fatalf("path: %s", call.path)
	}
	if call.key != "test-key" {
		t.Fatalf("the key must travel in the x-goog-api-key header, got %q", call.key)
	}
	for _, want := range []string{
		base64.StdEncoding.EncodeToString(png1x1), // the image itself
		"image/png",
		"Κτίριο", "Εσωτερικό", // the user's levels
		"beton",              // the user's own tags
		"application/json",   // JSON mode
		"responseJsonSchema", // schema keeps the answer parseable
	} {
		if !strings.Contains(call.body, want) {
			t.Fatalf("request body misses %q:\n%s", want, call.body)
		}
	}
	if strings.Contains(call.body, "bobsecret") {
		t.Fatalf("another user's tag leaked into the prompt")
	}
	s := e.suggestionOf(id)
	if s == nil || s.Level != e.levelID(alice.Id, "Κτίριο") || strings.Join(s.Tags, ",") != "ξύλο,φως" {
		t.Fatalf("stored suggestion: %+v", s)
	}
	// The suggestion never changes the real labels.
	r, _ := e.app.FindRecordById("inspirations", id)
	if r.GetString("level") != "" || len(r.GetStringSlice("tags")) != 0 {
		t.Fatalf("labels changed: %q %v", r.GetString("level"), r.Get("tags"))
	}
}

func TestAIOffByDefaultAndWhenAlreadyLabeled(t *testing.T) {
	f := newFakeGemini(t, goodReply)
	e, l := aiEnv(t, f, 100)
	alice, aTok := e.user("alice@x.gr")

	// Off by default: the image never leaves the server.
	e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()
	if f.count() != 0 {
		t.Fatalf("AI off: want 0 calls, got %d", f.count())
	}

	e.setAI(alice.Id, true)
	// Level and tags both set: nothing left to suggest.
	e.newInspiration(aTok, map[string]string{"user_id": alice.Id, "tags": `["wood"]`, "level": e.levelID(alice.Id, "Υλικό")})
	l.Wait()
	if f.count() != 0 {
		t.Fatalf("fully labeled: want 0 calls, got %d", f.count())
	}
	// Only tags set: the level is still missing, so ask.
	id := e.newInspiration(aTok, map[string]string{"user_id": alice.Id, "tags": `["wood"]`})
	l.Wait()
	if f.count() != 1 || e.suggestionOf(id) == nil {
		t.Fatalf("tags only: want 1 call and a suggestion, got %d calls", f.count())
	}

	// Switching it off again stops the calls.
	e.setAI(alice.Id, false)
	e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()
	if f.count() != 1 {
		t.Fatalf("AI switched off: want still 1 call, got %d", f.count())
	}
}

func TestAIDropsUnknownLevelAndWritesNothingWhenEmpty(t *testing.T) {
	f := newFakeGemini(t, `{"level":"Πλανήτης","tags":["  Φως ","φως","a","b","c","d","e"]}`)
	e, l := aiEnv(t, f, 100)
	alice, aTok := e.user("alice@x.gr")
	e.setAI(alice.Id, true)

	id := e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()
	s := e.suggestionOf(id)
	if s == nil || s.Level != "" {
		t.Fatalf("an unknown level must be dropped, got %+v", s)
	}
	if len(s.Tags) != 5 || s.Tags[0] != "φως" {
		t.Fatalf("tags: want 5 cleaned tags, got %v", s.Tags)
	}

	f.mu.Lock()
	f.reply = `{"level":"Πλανήτης","tags":[]}`
	f.mu.Unlock()
	id2 := e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()
	if e.suggestionOf(id2) != nil {
		t.Fatalf("nothing usable in the answer: no suggestion expected")
	}

	f.mu.Lock()
	f.reply = `not json at all`
	f.mu.Unlock()
	id3 := e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()
	if e.suggestionOf(id3) != nil {
		t.Fatalf("malformed answer: no suggestion expected")
	}
}

func TestAIFailureNeverBreaksSaving(t *testing.T) {
	f := newFakeGemini(t, goodReply)
	e, l := aiEnv(t, f, 100)
	alice, aTok := e.user("alice@x.gr")
	e.setAI(alice.Id, true)

	// 429 once, then fine: one retry gets the suggestion.
	f.statuses = []int{429}
	id := e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()
	if f.count() != 2 || e.suggestionOf(id) == nil {
		t.Fatalf("429 then 200: want 2 calls and a suggestion, got %d calls", f.count())
	}

	// Two failures: give up after the single retry; the image is saved and unlabeled.
	f.statuses = []int{503, 503}
	before := f.count()
	id2 := e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
	l.Wait()
	if f.count() != before+2 {
		t.Fatalf("want exactly one retry, got %d calls", f.count()-before)
	}
	if e.suggestionOf(id2) != nil {
		t.Fatalf("failed call must not write a suggestion")
	}
	if _, err := e.app.FindRecordById("inspirations", id2); err != nil {
		t.Fatalf("the image must still exist: %v", err)
	}
}

func TestAIDailyLimitPerUser(t *testing.T) {
	f := newFakeGemini(t, goodReply)
	e, l := aiEnv(t, f, 2)
	alice, aTok := e.user("alice@x.gr")
	bob, bTok := e.user("bob@x.gr")
	e.setAI(alice.Id, true)
	e.setAI(bob.Id, true)

	for i := 0; i < 3; i++ {
		e.newInspiration(aTok, map[string]string{"user_id": alice.Id})
		l.Wait()
	}
	if f.count() != 2 {
		t.Fatalf("limit 2: want 2 calls for alice, got %d", f.count())
	}
	// Alice's limit does not use up Bob's.
	e.newInspiration(bTok, map[string]string{"user_id": bob.Id})
	l.Wait()
	if f.count() != 3 {
		t.Fatalf("bob has his own budget: want 3 calls in total, got %d", f.count())
	}
}

func TestAIUserCanSwitchItOnlyForHimself(t *testing.T) {
	f := newFakeGemini(t, goodReply)
	e, _ := aiEnv(t, f, 100)
	alice, aTok := e.user("alice@x.gr")
	bob, _ := e.user("bob@x.gr")
	if code, out := e.json("PATCH", "/api/collections/users/records/"+alice.Id, aTok, map[string]any{"ai_enabled": true}); code != 200 || !strings.Contains(out, `"ai_enabled":true`) {
		t.Fatalf("alice switches her own AI on: %d %s", code, out)
	}
	if code, _ := e.json("PATCH", "/api/collections/users/records/"+bob.Id, aTok, map[string]any{"ai_enabled": true}); code == 200 {
		t.Fatalf("alice switched on bob's AI")
	}
}

// postImage sends one image to /api/mb/suggest (multipart, like the web app and the extension).
func (e *env) postImage(tok string, body []byte) (int, string) {
	e.t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, _ := w.CreateFormFile("image", "a.png")
	_, _ = part.Write(body)
	_ = w.Close()
	return e.req("POST", "/api/mb/suggest", tok, &buf, w.FormDataContentType())
}

func countInspirations(e *env) int {
	e.t.Helper()
	rs, err := e.app.FindAllRecords("inspirations")
	if err != nil {
		e.t.Fatal(err)
	}
	return len(rs)
}

func TestSuggestEndpoint(t *testing.T) {
	f := newFakeGemini(t, goodReply)
	e, l := aiEnv(t, f, 100)
	alice, aTok := e.user("alice@x.gr")

	if code, _ := e.postImage("", png1x1); code != 401 {
		t.Fatalf("anonymous: want 401, got %d", code)
	}
	// AI off: answers "off" and sends nothing to Google.
	code, out := e.postImage(aTok, png1x1)
	if code != 200 || !strings.Contains(out, `"enabled":false`) || f.count() != 0 {
		t.Fatalf("AI off: %d %s (%d calls)", code, out, f.count())
	}

	e.setAI(alice.Id, true)
	code, out = e.postImage(aTok, png1x1)
	if code != 200 || f.count() != 1 {
		t.Fatalf("AI on: %d %s (%d calls)", code, out, f.count())
	}
	var got struct {
		Enabled bool     `json:"enabled"`
		Level   string   `json:"level"`
		Tags    []string `json:"tags"`
	}
	_ = json.Unmarshal([]byte(out), &got)
	if !got.Enabled || got.Level != e.levelID(alice.Id, "Κτίριο") || strings.Join(got.Tags, ",") != "ξύλο,φως" {
		t.Fatalf("answer: %s", out)
	}
	if !strings.Contains(f.calls[0].body, base64.StdEncoding.EncodeToString(png1x1)) || f.calls[0].key != "test-key" {
		t.Fatalf("the image or key did not reach the model")
	}
	// Nothing is stored: a prefill is not a suggestion on a row.
	if n := countInspirations(e); n != 0 {
		t.Fatalf("suggest must not create rows, found %d", n)
	}
	l.Wait()
	if f.count() != 1 {
		t.Fatalf("suggest must not queue background work")
	}

	// Not an image.
	if code, _ = e.postImage(aTok, []byte("hello, I am not an image")); code != 400 {
		t.Fatalf("text body: want 400, got %d", code)
	}
	// Gemini down (after the single retry): 502, the client just skips the prefill.
	f.statuses = []int{503, 503}
	if code, _ = e.postImage(aTok, png1x1); code != 502 {
		t.Fatalf("Gemini down: want 502, got %d", code)
	}
}

func TestSuggestEndpointDailyLimitAndNoLabeler(t *testing.T) {
	f := newFakeGemini(t, goodReply)
	e, _ := aiEnv(t, f, 1)
	alice, aTok := e.user("alice@x.gr")
	e.setAI(alice.Id, true)
	if code, _ := e.postImage(aTok, png1x1); code != 200 {
		t.Fatalf("first call: %d", code)
	}
	if code, _ := e.postImage(aTok, png1x1); code != 429 {
		t.Fatalf("over the limit: want 429, got %d", code)
	}

	// A server without a Gemini key answers "off".
	e2 := newEnv(t)
	bob, bTok := e2.user("bob@x.gr")
	e2.setAI(bob.Id, true)
	if code, out := e2.postImage(bTok, png1x1); code != 200 || !strings.Contains(out, `"enabled":false`) {
		t.Fatalf("no labeler: %d %s", code, out)
	}
}
