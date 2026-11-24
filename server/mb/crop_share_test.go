package mb_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	_ "image/jpeg"
	_ "image/png"
	"testing"

	"moodboard/server/mb"
)

// halves is 200x100: the left half red, the right half blue.
func halves() []byte {
	return pngOf(200, 100, func(x, _ int) color.Color {
		if x < 100 {
			return color.RGBA{255, 0, 0, 255}
		}
		return color.RGBA{0, 0, 255, 255}
	})
}

// croppedFixture: a public board with one image whose crop keeps only the blue right half.
func croppedFixture(t *testing.T) (*shareFixture, string) {
	f := newShareFixture(t)
	f.set(t, map[string]any{"public": true})
	owner, err := f.e.app.FindRecordById("inspirations", f.insA)
	if err != nil {
		t.Fatal(err)
	}
	r := f.e.uploadImage(f.aTok, map[string]string{
		"user_id":    owner.GetString("user_id"),
		"project_id": f.projA,
		"crop":       `{"x":0.5,"y":0,"w":0.5,"h":1}`,
		"regions":    `[{"x":0.6,"y":0.1,"w":0.2,"h":0.2,"note":"μέσα"},{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"note":"έξω"},{"x":0.4,"y":0.4,"w":0.1,"h":0.1,"note":"στην άκρη"}]`,
	}, halves())
	return f, r.Id
}

// decoded fetches a public image URL and decodes it.
func decoded(t *testing.T, e *env, url string) image.Image {
	t.Helper()
	w := e.rawWith("GET", url, nil)
	if w.Code != 200 {
		t.Fatalf("%s: %d %s", url, w.Code, w.Body.String())
	}
	img, _, err := image.Decode(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("%s: not an image: %v", url, err)
	}
	return img
}

// noRed fails when any pixel of img is clearly red (a pixel from the cropped-out half).
func noRed(t *testing.T, url string, img image.Image) {
	t.Helper()
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, _, bl, _ := img.At(x, y).RGBA()
			if r>>8 > 100 && bl>>8 < 150 {
				t.Fatalf("%s: pixel (%d,%d) comes from the cropped-out part", url, x, y)
			}
		}
	}
}

func TestPublicImageServesOnlyTheCrop(t *testing.T) {
	f, id := croppedFixture(t)
	base := "/api/mb/public/" + f.projA + "/files/" + id
	for _, u := range []string{base, base + "?thumb=480x0", base + "?thumb=hi"} {
		img := decoded(t, f.e, u)
		b := img.Bounds()
		if b.Dx() != b.Dy() {
			t.Fatalf("%s: %dx%d, want the square crop", u, b.Dx(), b.Dy())
		}
		noRed(t, u, img)
	}
	if b := decoded(t, f.e, base).Bounds(); b.Dx() != 100 {
		t.Fatalf("full crop is %d px wide, want 100 (the real pixels of the crop)", b.Dx())
	}
}

func TestPublicImageFollowsANewCrop(t *testing.T) {
	f, id := croppedFixture(t)
	if code, out := f.e.json("PATCH", "/api/collections/inspirations/records/"+id, f.aTok, map[string]any{"crop": map[string]float64{"x": 0, "y": 0, "w": 0.5, "h": 1}}); code != 200 {
		t.Fatalf("patch crop: %d %s", code, out)
	}
	mb.WaitThumbs()
	img := decoded(t, f.e, "/api/mb/public/"+f.projA+"/files/"+id)
	r, _, bl, _ := img.At(img.Bounds().Dx()/2, img.Bounds().Dy()/2).RGBA()
	if r>>8 < 200 || bl>>8 > 60 {
		t.Fatalf("after the new crop (left half) the image must be red, got r=%d b=%d", r>>8, bl>>8)
	}
}

func TestResolverNeverHandsOutACroppedOriginal(t *testing.T) {
	f, id := croppedFixture(t)
	mb.EnableResolver("s3cret")
	t.Cleanup(func() { mb.EnableResolver("") })
	w := f.e.rawWith("GET", "/api/mb/public/"+f.projA+"/files/"+id+"/src", map[string]string{"X-MB-Resolve": "s3cret"})
	if w.Code != 200 {
		t.Fatalf("resolve: %d %s", w.Code, w.Body.String())
	}
	var got struct{ Key, Thumb string }
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// The bucket holds the whole original: with a crop the Worker must ask this server for the image.
	if got.Key != "" || got.Thumb != "" {
		t.Fatalf("cropped image: resolver gave key %q thumb %q, want none", got.Key, got.Thumb)
	}
}

func TestPublicBoardSendsRegionsInCropCoordinates(t *testing.T) {
	f, id := croppedFixture(t)
	var board struct {
		Items []struct {
			Id      string
			Crop    any
			Regions []struct {
				X, Y, W, H float64
				Note       string
			}
		} `json:"inspirations"`
	}
	if err := json.Unmarshal([]byte(f.view(t, 200)), &board); err != nil {
		t.Fatal(err)
	}
	for _, it := range board.Items {
		if it.Id != id {
			continue
		}
		// The served image is already cropped: the client must not crop it again.
		if it.Crop != nil {
			t.Fatalf("crop %v, want null", it.Crop)
		}
		if len(it.Regions) != 1 || it.Regions[0].Note != "μέσα" {
			t.Fatalf("regions %+v, want only the one inside the crop", it.Regions)
		}
		r := it.Regions[0]
		near := func(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }
		if !near(r.X, 0.2) || !near(r.W, 0.4) || !near(r.Y, 0.1) || !near(r.H, 0.2) {
			t.Fatalf("region %+v, want x 0.2 w 0.4 y 0.1 h 0.2", r)
		}
		return
	}
	t.Fatalf("image %s not on the board", id)
}
