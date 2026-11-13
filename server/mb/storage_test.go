package mb_test

import (
	"encoding/json"
	"testing"

	"moodboard/server/mb"
)

// The image bucket has a free tier; a new upload is refused once the stored files pass the limit.
func TestUploadRefusedWhenStoreIsFull(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	e.uploaded(tok, map[string]string{"user_id": u.Id})
	mb.WaitThumbs()
	defer mb.SetStoreLimit(8 << 30)

	mb.SetStoreLimit(1)
	if code, out := e.upload(tok, map[string]string{"user_id": u.Id}); code != 413 {
		t.Fatalf("upload over the storage limit: want 413, got %d %s", code, out)
	}

	mb.SetStoreLimit(8 << 30)
	if code, out := e.upload(tok, map[string]string{"user_id": u.Id}); code != 200 {
		t.Fatalf("upload under the limit: %d %s", code, out)
	}
	mb.WaitThumbs()
}

// A copy is a new inspiration too: it must get the same refusal, not a generic 400.
func TestCopyRefusedWhenStoreIsFull(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r := e.uploaded(tok, map[string]string{"user_id": u.Id})
	mb.WaitThumbs()
	defer mb.SetStoreLimit(8 << 30)
	mb.SetStoreLimit(1)
	code, out := e.json("POST", "/api/mb/inspirations/"+r.Id+"/copy", tok, map[string]any{"project_id": nil})
	if code != 413 {
		t.Fatalf("copy over the storage limit: want 413, got %d %s", code, out)
	}
	var body struct{ Message string }
	_ = json.Unmarshal([]byte(out), &body)
	if body.Message == "" {
		t.Fatalf("no message in %s", out)
	}
}
