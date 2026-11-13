package mb_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"moodboard/server/mb"
)

// pngOf draws an image with f and encodes it as PNG.
func pngOf(w, h int, f func(x, y int) color.Color) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, f(x, y))
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func solid(w, h int, c color.Color) []byte {
	return pngOf(w, h, func(int, int) color.Color { return c })
}

// gradient goes dark to light along x; flip reverses it. Its shape, not its size, decides the hash.
func gradient(w, h int, flip bool) []byte {
	return pngOf(w, h, func(x, y int) color.Color {
		v := uint8(255 * x / (w - 1))
		if flip {
			v = 255 - v
		}
		return color.RGBA{v, v, v, 255}
	})
}

// uploadImage creates an inspiration with the given PNG bytes through the public API.
func (e *env) uploadImage(token string, fields map[string]string, img []byte) *core.Record {
	e.t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	part, _ := w.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="image"; filename="a.png"`},
		"Content-Type":        {"image/png"},
	})
	_, _ = part.Write(img)
	_ = w.Close()
	code, out := e.req("POST", "/api/collections/inspirations/records", token, &buf, w.FormDataContentType())
	if code != 200 {
		e.t.Fatalf("upload: %d %s", code, out)
	}
	var row struct{ Id string }
	_ = json.Unmarshal([]byte(out), &row)
	mb.WaitThumbs()
	r, err := e.app.FindRecordById("inspirations", row.Id)
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

func (e *env) featuresOf(id string) *core.Record {
	e.t.Helper()
	r, err := e.app.FindFirstRecordByData("image_features", "inspiration_id", id)
	if err != nil {
		return nil
	}
	return r
}

func colorsOf(r *core.Record) []string {
	var c []string
	_ = r.UnmarshalJSONField("colors", &c)
	return c
}

func TestAnalyzeSolidColor(t *testing.T) {
	colors, _, err := mb.AnalyzeImage(bytes.NewReader(solid(16, 16, color.RGBA{255, 0, 0, 255})))
	if err != nil {
		t.Fatal(err)
	}
	if len(colors) != 1 || colors[0] != "#ff0000" {
		t.Fatalf("want [#ff0000], got %v", colors)
	}
}

func TestAnalyzeTwoColorsMostCommonFirst(t *testing.T) {
	img := pngOf(40, 40, func(x, y int) color.Color {
		if x < 30 { // 75% blue
			return color.RGBA{0, 0, 255, 255}
		}
		return color.RGBA{255, 255, 0, 255}
	})
	colors, _, err := mb.AnalyzeImage(bytes.NewReader(img))
	if err != nil {
		t.Fatal(err)
	}
	if len(colors) != 2 || colors[0] != "#0000ff" || colors[1] != "#ffff00" {
		t.Fatalf("want [#0000ff #ffff00], got %v", colors)
	}
}

func TestAnalyzeIgnoresTransparent(t *testing.T) {
	img := pngOf(20, 20, func(x, y int) color.Color {
		if x < 15 {
			return color.RGBA{0, 0, 0, 0}
		}
		return color.RGBA{0, 255, 0, 255}
	})
	colors, _, err := mb.AnalyzeImage(bytes.NewReader(img))
	if err != nil || len(colors) != 1 || colors[0] != "#00ff00" {
		t.Fatalf("want [#00ff00], got %v %v", colors, err)
	}
}

func TestAnalyzeRejectsNonImage(t *testing.T) {
	if _, _, err := mb.AnalyzeImage(strings.NewReader("not an image")); err == nil {
		t.Fatal("want an error")
	}
}

func TestDHashIgnoresSizeButSeesShape(t *testing.T) {
	_, small, _ := mb.AnalyzeImage(bytes.NewReader(gradient(32, 32, false)))
	_, big, _ := mb.AnalyzeImage(bytes.NewReader(gradient(200, 120, false)))
	_, flipped, _ := mb.AnalyzeImage(bytes.NewReader(gradient(32, 32, true)))
	if d := mb.Hamming(small, big); d > 6 {
		t.Fatalf("same picture at two sizes: distance %d, want <= 6", d)
	}
	if d := mb.Hamming(small, flipped); d < 20 {
		t.Fatalf("mirrored picture: distance %d, want >= 20", d)
	}
}

func TestUploadStoresColorsAndHash(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, color.RGBA{255, 0, 0, 255}))
	if c := colorsOf(r); len(c) != 1 || c[0] != "#ff0000" {
		t.Fatalf("colors: %v", c)
	}
	f := e.featuresOf(r.Id)
	if f == nil {
		t.Fatal("no image_features row")
	}
	// A flat picture is done, but has no hash to compare.
	if f.GetString("phash") != "flat" || f.GetString("user_id") != u.Id {
		t.Fatalf("row: phash %q user %q", f.GetString("phash"), f.GetString("user_id"))
	}
	g := e.uploadImage(tok, map[string]string{"user_id": u.Id}, gradient(32, 32, false))
	if h := e.featuresOf(g.Id).GetString("phash"); len(h) != 16 {
		t.Fatalf("a picture with shapes gets 16 hex digits, got %q", h)
	}
}

// A fully transparent image has no colors. Saving "[]" fires the update hook again, so it must count
// as done (a first version recomputed it forever and hung every test that uploads the 1x1 PNG).
func TestTransparentImageIsDoneNotRetried(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(8, 8, color.RGBA{0, 0, 0, 0}))
	if c := r.GetString("colors"); c != "[]" {
		t.Fatalf("colors: %q, want []", c)
	}
	if n := mb.BackfillFeatures(e.app, time.Millisecond, nil); n != 0 {
		t.Fatalf("backfill redid it: %d", n)
	}
}

func TestFeaturesRowDeletedWithInspiration(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, color.RGBA{0, 0, 255, 255}))
	if e.featuresOf(r.Id) == nil {
		t.Fatal("no row to delete")
	}
	if err := e.app.Delete(r); err != nil {
		t.Fatal(err)
	}
	if e.featuresOf(r.Id) != nil {
		t.Fatal("row survived the delete")
	}
}

func TestBackfillFeaturesOnlyMissing(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, color.RGBA{255, 0, 0, 255}))
	if n := mb.BackfillFeatures(e.app, time.Millisecond, nil); n != 0 {
		t.Fatalf("nothing is missing, made %d", n)
	}
	if err := e.app.Delete(e.featuresOf(r.Id)); err != nil {
		t.Fatal(err)
	}
	r.Set("colors", nil)
	r.IgnoreUnchangedFields(true)
	if err := e.app.Save(r); err != nil {
		t.Fatal(err)
	}
	if n := mb.BackfillFeatures(e.app, time.Millisecond, nil); n != 1 {
		t.Fatalf("one image lacks features, made %d", n)
	}
	r, _ = e.app.FindRecordById("inspirations", r.Id)
	if c := colorsOf(r); len(c) != 1 || e.featuresOf(r.Id) == nil {
		t.Fatalf("not restored: colors %v", c)
	}
	if n := mb.BackfillFeatures(e.app, time.Millisecond, nil); n != 0 {
		t.Fatalf("second run made %d", n)
	}
}
