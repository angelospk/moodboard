package mb_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCropImageURLAndThumbs(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	code, out := e.upload(tok, map[string]string{"user_id": u.Id, "image_url": "https://example.com/a.png", "crop": `{"x":0.1,"y":0.2,"w":0.5,"h":0.5}`})
	if code != 200 || !strings.Contains(out, `"image_url":"https://example.com/a.png"`) || !strings.Contains(out, `"w":0.5`) {
		t.Fatalf("create with crop + image_url: %d %s", code, out)
	}
	var row struct{ Id, Image string }
	_ = json.Unmarshal([]byte(out), &row)
	url := "/api/collections/inspirations/records/" + row.Id

	for _, bad := range []string{`{"x":0.6,"y":0,"w":0.5,"h":0.5}`, `{"x":0,"y":0,"w":0.01,"h":0.5}`, `{"x":-0.1,"y":0,"w":0.5,"h":0.5}`, `{"x":0}`, `[1,2]`} {
		if code, out := e.json("PATCH", url, tok, map[string]any{"crop": json.RawMessage(bad)}); code != 400 {
			t.Fatalf("crop %s: want 400, got %d %s", bad, code, out)
		}
	}
	if code, out := e.json("PATCH", url, tok, map[string]any{"crop": nil}); code != 200 {
		t.Fatalf("clear crop: %d %s", code, out)
	}
	if code, _ := e.json("PATCH", url, tok, map[string]any{"image_url": "javascript:alert(1)"}); code != 400 {
		t.Fatalf("image_url must be a URL: got %d", code)
	}

	// Thumbnails: 480x0 is allowed; file tokens last 7 days.
	users, _ := e.app.FindCollectionByNameOrId("users")
	if users.FileToken.Duration != int64((7 * 24 * time.Hour).Seconds()) {
		t.Fatalf("file token duration: %d", users.FileToken.Duration)
	}
	c, _ := e.app.FindCollectionByNameOrId("inspirations")
	if !strings.Contains(fieldJSON(t, c.Fields.GetByName("image")), `"480x0"`) {
		t.Fatal("thumb 480x0 missing")
	}
}

func fieldJSON(t *testing.T, v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCopyKeepsCropAndImageURL(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	_, out := e.upload(tok, map[string]string{"user_id": u.Id, "image_url": "https://example.com/a.png", "crop": `{"x":0.1,"y":0.1,"w":0.5,"h":0.5}`})
	var row struct{ Id string }
	_ = json.Unmarshal([]byte(out), &row)
	code, out := e.json("POST", "/api/mb/inspirations/"+row.Id+"/copy", tok, map[string]any{"project_id": nil})
	if code != 200 {
		t.Fatalf("copy: %d %s", code, out)
	}
	var cp struct{ Id string }
	_ = json.Unmarshal([]byte(out), &cp)
	rec, err := e.app.FindRecordById("inspirations", cp.Id)
	if err != nil || rec.GetString("image_url") != "https://example.com/a.png" || !strings.Contains(rec.GetString("crop"), `"w":0.5`) {
		t.Fatalf("copy lost crop/image_url: %v %v", err, rec)
	}
}
