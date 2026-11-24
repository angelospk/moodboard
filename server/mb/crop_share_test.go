package mb_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strings"
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
		"regions":    `[{"x":0.6,"y":0.1,"w":0.2,"h":0.2,"note":"μέσα"},{"x":0.1,"y":0.1,"w":0.2,"h":0.2,"note":"έξω"},{"x":0.4,"y":0.4,"w":0.1,"h":0.1,"note":"στην άκρη"},{"x":0.3,"y":0.6,"w":0.4,"h":0.3,"note":"πολύγωνο έξω","points":[[0.3,0.6],[0.45,0.6],[0.3,0.9]]}]`,
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

// cropFiles lists the stored cropped copies of a record.
func cropFiles(t *testing.T, e *env, id string) []string {
	t.Helper()
	fsys, err := e.app.NewFilesystem()
	if err != nil {
		t.Fatal(err)
	}
	defer fsys.Close()
	objs, err := fsys.List("mbinspirations/" + id + "/")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, o := range objs {
		if strings.Contains(o.Key, "/crops_") {
			out = append(out, o.Key)
		}
	}
	return out
}

func TestPublicImageFollowsANewCrop(t *testing.T) {
	f, id := croppedFixture(t)
	base := "/api/mb/public/" + f.projA + "/files/" + id
	decoded(t, f.e, base)
	decoded(t, f.e, base+"?thumb=480x0")
	if n := len(cropFiles(t, f.e, id)); n != 2 {
		t.Fatalf("after warming: %d cropped files, want 2 (copy and thumbnail)", n)
	}
	if code, out := f.e.json("PATCH", "/api/collections/inspirations/records/"+id, f.aTok, map[string]any{"crop": map[string]float64{"x": 0, "y": 0, "w": 0.5, "h": 1}}); code != 200 {
		t.Fatalf("patch crop: %d %s", code, out)
	}
	mb.WaitThumbs()
	if left := cropFiles(t, f.e, id); len(left) != 0 {
		t.Fatalf("copies of the old crop left behind: %v", left)
	}
	for _, u := range []string{base, base + "?thumb=480x0"} {
		img := decoded(t, f.e, u)
		r, _, bl, _ := img.At(img.Bounds().Dx()/2, img.Bounds().Dy()/2).RGBA()
		if r>>8 < 200 || bl>>8 > 60 {
			t.Fatalf("%s: after the new crop (left half) the image must be red, got r=%d b=%d", u, r>>8, bl>>8)
		}
	}
}

// Two crops that differ by less than a rounding step are different crops: never one copy for both.
func TestNearlyEqualCropsGetTheirOwnCopy(t *testing.T) {
	f, id := croppedFixture(t)
	base := "/api/mb/public/" + f.projA + "/files/" + id
	decoded(t, f.e, base)
	if code, out := f.e.json("PATCH", "/api/collections/inspirations/records/"+id, f.aTok, map[string]any{"crop": map[string]float64{"x": 0.50001, "y": 0, "w": 0.49999, "h": 1}}); code != 200 {
		t.Fatalf("patch crop: %d %s", code, out)
	}
	mb.WaitThumbs()
	if left := cropFiles(t, f.e, id); len(left) != 0 {
		t.Fatalf("a nearly equal crop reused the old copy: %v", left)
	}
}

// The browser shows a PNG turned by its eXIf Orientation; the crop is drawn on that view.
func TestCropFollowsTheOrientationOfAPNG(t *testing.T) {
	f := newShareFixture(t)
	f.set(t, map[string]any{"public": true})
	owner, _ := f.e.app.FindRecordById("inspirations", f.insA)
	raw := halves() // 200x100, red left, blue right
	// Orientation 6: shown turned 90 degrees clockwise, so 100x200 with red on top, blue below.
	tiff := []byte("MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x06\x00\x00\x00\x00\x00\x00")
	withExif := append(append(append([]byte{}, raw[:33]...), pngChunk("eXIf", tiff)...), raw[33:]...)
	r := f.e.uploadImage(f.aTok, map[string]string{"user_id": owner.GetString("user_id"), "project_id": f.projA,
		"crop": `{"x":0,"y":0.5,"w":1,"h":0.5}`}, withExif)
	u := "/api/mb/public/" + f.projA + "/files/" + r.Id
	img := decoded(t, f.e, u)
	if b := img.Bounds(); b.Dx() != 100 || b.Dy() != 100 {
		t.Fatalf("crop of the turned image is %dx%d, want 100x100", b.Dx(), b.Dy())
	}
	noRed(t, u, img)
}

// A GIF frame may sit inside a larger canvas; the crop is a fraction of the canvas.
func TestCropOfAGIFUsesItsCanvas(t *testing.T) {
	f := newShareFixture(t)
	f.set(t, map[string]any{"public": true})
	owner, _ := f.e.app.FindRecordById("inspirations", f.insA)
	pal := color.Palette{color.RGBA{0, 0, 0, 0}, color.RGBA{0, 0, 255, 255}}
	frame := image.NewPaletted(image.Rect(100, 0, 200, 100), pal) // only the right half is drawn
	for y := 0; y < 100; y++ {
		for x := 100; x < 200; x++ {
			frame.SetColorIndex(x, y, 1)
		}
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, &gif.GIF{Image: []*image.Paletted{frame}, Delay: []int{0}, Config: image.Config{ColorModel: pal, Width: 200, Height: 100}}); err != nil {
		t.Fatal(err)
	}
	id := f.e.uploadFile(f.aTok, map[string]string{"user_id": owner.GetString("user_id"), "project_id": f.projA,
		"crop": `{"x":0.5,"y":0,"w":0.5,"h":1}`}, "a.gif", "image/gif", buf.Bytes())
	mb.WaitThumbs()
	img := decoded(t, f.e, "/api/mb/public/"+f.projA+"/files/"+id)
	if b := img.Bounds(); b.Dx() != 100 || b.Dy() != 100 {
		t.Fatalf("crop is %dx%d, want 100x100 (the right half of the 200x100 canvas)", b.Dx(), b.Dy())
	}
	_, _, bl, a := img.At(50, 50).RGBA()
	if bl>>8 < 200 || a>>8 < 200 {
		t.Fatalf("crop centre must be opaque blue")
	}
}

// A transparent image stays transparent, whatever its name says: a GIF named .jpg must not become a JPEG.
func TestCropKeepsTransparency(t *testing.T) {
	f := newShareFixture(t)
	f.set(t, map[string]any{"public": true})
	owner, _ := f.e.app.FindRecordById("inspirations", f.insA)
	pal := color.Palette{color.RGBA{0, 0, 0, 0}, color.RGBA{0, 0, 255, 255}}
	frame := image.NewPaletted(image.Rect(0, 0, 200, 100), pal) // all transparent
	var buf bytes.Buffer
	if err := gif.Encode(&buf, frame, nil); err != nil {
		t.Fatal(err)
	}
	id := f.e.uploadFile(f.aTok, map[string]string{"user_id": owner.GetString("user_id"), "project_id": f.projA,
		"crop": `{"x":0.5,"y":0,"w":0.5,"h":1}`}, "a.jpg", "image/jpeg", buf.Bytes())
	mb.WaitThumbs()
	img := decoded(t, f.e, "/api/mb/public/"+f.projA+"/files/"+id)
	if _, _, _, a := img.At(10, 10).RGBA(); a != 0 {
		t.Fatalf("alpha %d, want 0", a)
	}
}

// A very thin crop would make a huge 480x0 thumbnail: the thumbnail fails closed, the crop itself is served.
func TestThinCropThumbnailFailsClosed(t *testing.T) {
	f, id := croppedFixture(t)
	if code, out := f.e.json("PATCH", "/api/collections/inspirations/records/"+id, f.aTok, map[string]any{"crop": map[string]float64{"x": 0.5, "y": 0, "w": 0.02, "h": 1}}); code != 200 {
		t.Fatalf("patch crop: %d %s", code, out)
	}
	mb.WaitThumbs()
	old := mb.SetMaxCropPixels(1_000_000) // the 4x100 crop's 480x12000 thumbnail is over it
	t.Cleanup(func() { mb.SetMaxCropPixels(old) })
	base := "/api/mb/public/" + f.projA + "/files/" + id
	if w := f.e.rawWith("GET", base, nil); w.Code != 200 {
		t.Fatalf("thin crop: %d, want 200", w.Code)
	}
	if w := f.e.rawWith("GET", base+"?thumb=480x0", nil); w.Code != 404 {
		t.Fatalf("thumbnail over the limit: %d, want 404", w.Code)
	}
}

// Removing old crop copies never touches an uploaded original whose own name starts with crops_.
func TestPruneKeepsAnOriginalNamedLikeACrop(t *testing.T) {
	f := newShareFixture(t)
	f.set(t, map[string]any{"public": true})
	owner, _ := f.e.app.FindRecordById("inspirations", f.insA)
	id := f.e.uploadFile(f.aTok, map[string]string{"user_id": owner.GetString("user_id"), "project_id": f.projA,
		"crop": `{"x":0.5,"y":0,"w":0.5,"h":1}`}, "crops_a.png", "image/png", halves())
	mb.WaitThumbs()
	decoded(t, f.e, "/api/mb/public/"+f.projA+"/files/"+id)
	if code, out := f.e.json("PATCH", "/api/collections/inspirations/records/"+id, f.aTok, map[string]any{"crop": nil}); code != 200 {
		t.Fatalf("patch crop: %d %s", code, out)
	}
	mb.WaitThumbs()
	img := decoded(t, f.e, "/api/mb/public/"+f.projA+"/files/"+id)
	if b := img.Bounds(); b.Dx() != 200 {
		t.Fatalf("original lost or changed: %dx%d", b.Dx(), b.Dy())
	}
}

// Fill bytes (0xFF) before a JPEG marker are legal; the Orientation after them still counts.
func TestOrientationReadsPastJPEGFillBytes(t *testing.T) {
	tiff := []byte("MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x06\x00\x00\x00\x00\x00\x00")
	app1 := append([]byte("Exif\x00\x00"), tiff...)
	n := len(app1) + 2
	b := []byte{0xFF, 0xD8, 0xFF, 0xFF, 0xFF, 0xE1, byte(n >> 8), byte(n)}
	b = append(append(b, app1...), 0xFF, 0xDA, 0x00, 0x02)
	if o := mb.OrientationOf(b); o != 6 {
		t.Fatalf("orientation %d, want 6", o)
	}
}

func TestPolygonOverlapNeedsArea(t *testing.T) {
	for _, c := range []struct {
		name string
		poly [][2]float64
		want bool
	}{
		{"touches a corner from outside", [][2]float64{{1, 1}, {2, 1}, {1, 2}}, false},
		{"touches the origin corner from outside", [][2]float64{{0, 0}, {-1, 0}, {0, -1}}, false},
		{"shares an edge from outside", [][2]float64{{1, 0}, {2, 0}, {2, 1}, {1, 1}}, false},
		{"covers the square", [][2]float64{{-1, -1}, {3, -1}, {-1, 3}}, true},
		{"crosses one side", [][2]float64{{-1, 0.4}, {0.2, 0.5}, {-1, 0.6}}, true},
	} {
		if got := mb.PolygonMeetsUnitSquare(c.poly); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// An image too large to decode safely is not served at all (never the uncropped file).
func TestHugeCroppedImageFailsClosed(t *testing.T) {
	f, id := croppedFixture(t)
	old := mb.SetMaxCropPixels(100 * 100)
	t.Cleanup(func() { mb.SetMaxCropPixels(old) })
	if w := f.e.rawWith("GET", "/api/mb/public/"+f.projA+"/files/"+id, nil); w.Code != 404 {
		t.Fatalf("over the pixel limit: %d, want 404", w.Code)
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
