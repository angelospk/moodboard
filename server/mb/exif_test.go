package mb_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"mime/multipart"
	"strings"
	"testing"

	"moodboard/server/mb"
)

// seg builds one JPEG segment: FF marker, 2-byte length (counting itself), payload.
func seg(marker byte, payload []byte) []byte {
	l := len(payload) + 2
	return append([]byte{0xFF, marker, byte(l >> 8), byte(l)}, payload...)
}

// exifPayload is an Exif APP1 payload with one Orientation tag, followed by secret bytes that no
// tag points to (they must disappear with the segment). le picks little-endian ("II").
func exifPayload(orientation uint16, le bool, secret string) []byte {
	var b bytes.Buffer
	b.WriteString("Exif\x00\x00")
	if le {
		b.Write([]byte{'I', 'I', 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, byte(orientation), byte(orientation >> 8), 0, 0, 0, 0, 0, 0})
	} else {
		b.Write([]byte{'M', 'M', 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, byte(orientation >> 8), byte(orientation), 0, 0, 0, 0, 0, 0})
	}
	b.WriteString(secret)
	return b.Bytes()
}

// plainJPEG is an 8x6 JPEG with no metadata.
func plainJPEG(t testing.TB) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	for x := 0; x < 8; x++ {
		for y := 0; y < 6; y++ {
			img.Set(x, y, color.RGBA{uint8(x * 30), uint8(y * 40), 128, 255})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// withSegments inserts segments right after the SOI marker.
func withSegments(jpg []byte, segs ...[]byte) []byte {
	out := append([]byte{}, jpg[:2]...)
	for _, s := range segs {
		out = append(out, s...)
	}
	return append(out, jpg[2:]...)
}

func strip(t *testing.T, in []byte) []byte {
	t.Helper()
	r, err := mb.StripJPEGMeta(bytes.NewReader(in))
	if err != nil {
		t.Fatalf("strip: %v", err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read stripped: %v", err)
	}
	return out
}

// keptOrientation is what the stripper writes when it keeps a rotation (big-endian, one tag).
func keptOrientation(o byte) []byte {
	return append([]byte("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00"), o, 0, 0, 0, 0, 0, 0)
}

func TestStripJPEGMetaDropsLocationAndText(t *testing.T) {
	plain := plainJPEG(t)
	icc := seg(0xE2, []byte("ICC_PROFILE\x00\x01\x01profile-bytes"))
	dirty := withSegments(plain,
		seg(0xE1, exifPayload(6, false, "SECRET-GPS-LAT-37.97")),
		seg(0xE1, []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>SECRET-XMP</x:xmpmeta>")),
		seg(0xFE, []byte("SECRET-COMMENT")),
		seg(0xED, []byte("Photoshop 3.0\x008BIMSECRET-IPTC")),
		icc,
	)
	out := strip(t, dirty)
	for _, leak := range []string{"SECRET-GPS", "SECRET-XMP", "SECRET-COMMENT", "SECRET-IPTC", "xmpmeta"} {
		if bytes.Contains(out, []byte(leak)) {
			t.Fatalf("%q survived the strip", leak)
		}
	}
	if !bytes.Contains(out, []byte("ICC_PROFILE")) {
		t.Fatalf("the colour profile must stay")
	}
	if !bytes.Contains(out, keptOrientation(6)) {
		t.Fatalf("the rotation (orientation 6) must survive as a minimal Exif")
	}
	if !bytes.HasPrefix(out, []byte{0xFF, 0xD8, 0xFF, 0xE1}) {
		t.Fatalf("the kept Exif must follow SOI directly")
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil || img.Bounds().Dx() != 8 || img.Bounds().Dy() != 6 {
		t.Fatalf("stripped JPEG must decode: %v", err)
	}
	// The picture data is untouched byte for byte: everything from the first quantisation table on.
	tail := func(b []byte) []byte { return b[bytes.Index(b, []byte{0xFF, 0xDB}):] }
	if !bytes.Equal(tail(out), tail(plain)) {
		t.Fatalf("scan data changed")
	}
}

func TestStripJPEGMetaOrientation(t *testing.T) {
	plain := plainJPEG(t)
	// Little-endian Exif is read too; orientation 1 (normal) and no orientation keep no Exif at all.
	if out := strip(t, withSegments(plain, seg(0xE1, exifPayload(8, true, "SECRET-GPS")))); !bytes.Contains(out, keptOrientation(8)) || bytes.Contains(out, []byte("SECRET")) {
		t.Fatalf("little-endian orientation 8 lost or leaked")
	}
	for name, in := range map[string][]byte{
		"orientation 1": withSegments(plain, seg(0xE1, exifPayload(1, false, "SECRET-GPS"))),
		"no tags":       withSegments(plain, seg(0xE1, []byte("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00SECRET-GPS"))),
		"junk exif":     withSegments(plain, seg(0xE1, []byte("Exif\x00\x00garbage SECRET-GPS"))),
		"orientation 9": withSegments(plain, seg(0xE1, exifPayload(9, false, "SECRET-GPS"))),
	} {
		out := strip(t, in)
		if bytes.Contains(out, []byte("Exif")) || bytes.Contains(out, []byte("SECRET")) {
			t.Fatalf("%s: no Exif should remain", name)
		}
		if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestStripJPEGMetaLeavesOtherFormatsAlone(t *testing.T) {
	r, err := mb.StripJPEGMeta(bytes.NewReader(png1x1))
	if err != nil {
		t.Fatal(err)
	}
	if out, _ := io.ReadAll(r); !bytes.Equal(out, png1x1) {
		t.Fatalf("a PNG must pass through unchanged")
	}
}

func TestStripJPEGMetaNeverPanicsOnBrokenInput(t *testing.T) {
	dirty := withSegments(plainJPEG(t), seg(0xE1, exifPayload(6, false, "SECRET-GPS")), seg(0xFE, []byte("c")))
	// Every truncation: an error or a clean result, never a panic, and a clean result never holds the secret.
	for i := 0; i <= len(dirty); i++ {
		r, err := mb.StripJPEGMeta(bytes.NewReader(dirty[:i]))
		if err != nil {
			continue
		}
		out, _ := io.ReadAll(r)
		if bytes.Contains(out, []byte("SECRET")) {
			t.Fatalf("truncated at %d leaks", i)
		}
	}
	// A segment that claims more bytes than the file has, and a length below 2.
	for name, in := range map[string][]byte{
		"length past end": {0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF, 'E', 'x'},
		"length below 2":  {0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x01, 0xFF, 0xD9},
	} {
		if r, err := mb.StripJPEGMeta(bytes.NewReader(in)); err == nil {
			if _, err = io.ReadAll(r); err == nil {
				t.Fatalf("%s: want an error", name)
			}
		}
	}
}

// uploadFile creates an inspiration with the given bytes, like the web client.
func (e *env) uploadFile(token string, fields map[string]string, filename, ctype string, data []byte) string {
	e.t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	part, _ := w.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="image"; filename="` + filename + `"`},
		"Content-Type":        {ctype},
	})
	_, _ = part.Write(data)
	_ = w.Close()
	code, out := e.req("POST", "/api/collections/inspirations/records", token, &buf, w.FormDataContentType())
	if code != 200 {
		e.t.Fatalf("upload: %d %s", code, out)
	}
	var r struct{ Id string }
	_ = json.Unmarshal([]byte(out), &r)
	return r.Id
}

func TestPublicBoardServesJPEGWithoutLocation(t *testing.T) {
	f := newShareFixture(t)
	alice, _ := f.e.app.FindAuthRecordByEmail("users", "alice@x.gr")
	dirty := withSegments(plainJPEG(t), seg(0xE1, exifPayload(6, false, "SECRET-GPS-LAT-37.97")))
	id := f.e.uploadFile(f.aTok, map[string]string{"user_id": alice.Id, "project_id": f.projA}, "phone.jpg", "image/jpeg", dirty)
	f.set(t, map[string]any{"public": true})

	w := f.e.raw("GET", "/api/mb/public/"+f.projA+"/files/"+id)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "image/jpeg") {
		t.Fatalf("public original: %d %q", w.Code, w.Header().Get("Content-Type"))
	}
	body := w.Body.Bytes()
	if bytes.Contains(body, []byte("SECRET-GPS")) {
		t.Fatalf("the public original still carries the location")
	}
	if !bytes.Contains(body, keptOrientation(6)) {
		t.Fatalf("the public original lost its rotation")
	}
	if _, err := jpeg.Decode(bytes.NewReader(body)); err != nil {
		t.Fatalf("public original does not decode: %v", err)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "private, max-age=300" {
		t.Fatalf("Cache-Control %q", cc)
	}
	// A PNG original is served as before.
	pw := f.e.raw("GET", "/api/mb/public/"+f.projA+"/files/"+f.insA)
	if pw.Code != 200 || !strings.HasPrefix(pw.Body.String(), "\x89PNG") {
		t.Fatalf("png original: %d", pw.Code)
	}
}
