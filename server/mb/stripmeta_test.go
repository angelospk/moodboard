package mb_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
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
	r, err := mb.StripImageMeta(bytes.NewReader(in))
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

func TestStripImageMetaDropsLocationAndText(t *testing.T) {
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

func TestStripImageMetaOrientation(t *testing.T) {
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

func TestStripImageMetaLeavesOtherFormatsAlone(t *testing.T) {
	r, err := mb.StripImageMeta(bytes.NewReader(png1x1))
	if err != nil {
		t.Fatal(err)
	}
	if out, _ := io.ReadAll(r); !bytes.Equal(out, png1x1) {
		t.Fatalf("a PNG must pass through unchanged")
	}
}

func TestStripImageMetaNeverPanicsOnBrokenInput(t *testing.T) {
	dirty := withSegments(plainJPEG(t), seg(0xE1, exifPayload(6, false, "SECRET-GPS")), seg(0xFE, []byte("c")))
	// Every truncation: an error or a clean result, never a panic, and a clean result never holds the secret.
	for i := 0; i <= len(dirty); i++ {
		r, err := mb.StripImageMeta(bytes.NewReader(dirty[:i]))
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
		if r, err := mb.StripImageMeta(bytes.NewReader(in)); err == nil {
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

// secretFree fails when any sentinel survived.
func secretFree(t *testing.T, name string, out []byte) {
	t.Helper()
	if bytes.Contains(out, []byte("SECRET")) {
		t.Fatalf("%s: a SECRET survived", name)
	}
}

func TestStripImageMetaJPEGAllowlist(t *testing.T) {
	plain := plainJPEG(t)
	jfif := func(thumbW, thumbH byte, thumb []byte) []byte {
		p := append([]byte("JFIF\x00\x01\x01\x00\x00\x01\x00\x01"), thumbW, thumbH)
		return seg(0xE0, append(p, thumb...))
	}
	dirty := withSegments(plain,
		jfif(2, 1, []byte("SECRET-JFIF-THUMB")[:6]),
		seg(0xE0, []byte("JFXX\x00\x10SECRET-JFXX-THUMB")),
		seg(0xE2, []byte("MPF\x00SECRET-MPF")),
		seg(0xE3, []byte("SECRET-APP3")),
		seg(0xEB, []byte("SECRET-APP11")),
		seg(0xEF, []byte("SECRET-APP15")),
		seg(0xE2, []byte("ICC_PROFILE\x00\x01\x01icc-data")),
		seg(0xEE, []byte("Adobe\x00\x64\x00\x00\x00\x00\x01")),
	)
	out := strip(t, dirty)
	secretFree(t, "allowlist", out)
	for _, keep := range []string{"JFIF\x00", "ICC_PROFILE", "Adobe"} {
		if !bytes.Contains(out, []byte(keep)) {
			t.Fatalf("%q must be kept", keep)
		}
	}
	if !bytes.Contains(out, append([]byte("JFIF\x00\x01\x01\x00\x00\x01\x00\x01"), 0, 0)) {
		t.Fatalf("the JFIF thumbnail size must be reset to 0x0")
	}
	if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
		t.Fatal(err)
	}
}

func TestStripImageMetaJPEGDropsTrailingDataAndMidFileComments(t *testing.T) {
	plain := plainJPEG(t)
	if plain[len(plain)-2] != 0xFF || plain[len(plain)-1] != 0xD9 {
		t.Fatal("test JPEG must end with EOI")
	}
	// A comment between the scan and EOI, then an embedded second JPEG with its own GPS (as phones
	// append a preview or a motion-photo video after EOI).
	second := withSegments(plainJPEG(t), seg(0xE1, exifPayload(1, false, "SECRET-SECOND-GPS")))
	body := append([]byte{}, plain[:len(plain)-2]...)
	body = append(body, seg(0xFE, []byte("SECRET-MID-COMMENT"))...)
	body = append(body, 0xFF, 0xD9)
	body = append(body, second...)
	body = append(body, []byte("SECRET-TRAILER")...)

	out := strip(t, body)
	secretFree(t, "trailing", out)
	if !bytes.HasSuffix(out, []byte{0xFF, 0xD9}) {
		t.Fatalf("output must end at the first EOI")
	}
	if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
		t.Fatalf("must still decode: %v", err)
	}
}

func TestStripImageMetaJPEGRejectsStrayMarkersInHeader(t *testing.T) {
	plain := plainJPEG(t)
	for name, in := range map[string][]byte{
		"restart marker in header": append([]byte{0xFF, 0xD8, 0xFF, 0xD3}, plain[2:]...),
		"TEM in header":            append([]byte{0xFF, 0xD8, 0xFF, 0x01}, plain[2:]...),
		"no EOI":                   plain[:len(plain)-2],
	} {
		if r, err := mb.StripImageMeta(bytes.NewReader(in)); err == nil {
			if _, err = io.ReadAll(r); err == nil {
				t.Fatalf("%s: want an error", name)
			}
		}
	}
	// Half a million stray markers must not be accepted as a "header".
	flood := append([]byte{0xFF, 0xD8}, bytes.Repeat([]byte{0xFF, 0x01}, 600_000)...)
	if _, err := mb.StripImageMeta(bytes.NewReader(flood)); err == nil {
		t.Fatalf("flood of markers accepted")
	}
}

func pngChunk(typ string, data []byte) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, uint32(len(data)))
	b.WriteString(typ)
	b.Write(data)
	_ = binary.Write(&b, binary.BigEndian, crc32.ChecksumIEEE(append([]byte(typ), data...)))
	return b.Bytes()
}

func TestStripImageMetaPNG(t *testing.T) {
	// png1x1 = signature + IHDR + IDAT + IEND; add eXIf, tEXt, iTXt (XMP), tIME after IHDR and junk after IEND.
	const sigAndIHDR = 8 + 12 + 13
	dirty := append([]byte{}, png1x1[:sigAndIHDR]...)
	dirty = append(dirty, pngChunk("eXIf", []byte("MM\x00*SECRET-PNG-GPS"))...)
	dirty = append(dirty, pngChunk("tEXt", []byte("Comment\x00SECRET-TEXT"))...)
	dirty = append(dirty, pngChunk("iTXt", []byte("XML:com.adobe.xmp\x00\x00\x00\x00\x00SECRET-XMP"))...)
	dirty = append(dirty, pngChunk("tIME", []byte{7, 234, 1, 1, 1, 1, 1})...)
	dirty = append(dirty, pngChunk("gAMA", []byte{0, 1, 0x86, 0xa0})...)
	dirty = append(dirty, png1x1[sigAndIHDR:]...)
	dirty = append(dirty, []byte("SECRET-AFTER-IEND")...)

	out := strip(t, dirty)
	secretFree(t, "png", out)
	for _, gone := range []string{"eXIf", "tEXt", "iTXt", "tIME"} {
		if bytes.Contains(out, []byte(gone)) {
			t.Fatalf("chunk %s must go", gone)
		}
	}
	if !bytes.Contains(out, []byte("gAMA")) {
		t.Fatalf("colour chunk gAMA must stay")
	}
	if _, err := png.Decode(bytes.NewReader(out)); err != nil {
		t.Fatalf("stripped PNG must decode: %v", err)
	}
	if _, err := mb.StripImageMeta(bytes.NewReader(png1x1[:30])); err == nil {
		// a truncated PNG may be an error or pass; it must not panic (checked by running)
		_ = err
	}
}

func riffChunk(fourcc string, payload []byte) []byte {
	b := append([]byte(fourcc), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(b[4:], uint32(len(payload)))
	b = append(b, payload...)
	if len(payload)%2 == 1 {
		b = append(b, 0)
	}
	return b
}

func TestStripImageMetaWebP(t *testing.T) {
	vp8x := []byte{0x08 | 0x04 | 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0} // EXIF + XMP + ICC flags, 1x1
	image := []byte("VP8L-image-bytes")
	body := append([]byte("WEBP"), riffChunk("VP8X", vp8x)...)
	body = append(body, riffChunk("ICCP", []byte("icc"))...)
	body = append(body, riffChunk("VP8L", image)...)
	body = append(body, riffChunk("EXIF", []byte("Exif\x00\x00SECRET-WEBP-GPS"))...)
	body = append(body, riffChunk("XMP ", []byte("SECRET-WEBP-XMP"))...)
	file := append([]byte("RIFF\x00\x00\x00\x00"), body...)
	binary.LittleEndian.PutUint32(file[4:], uint32(len(body)))

	out := strip(t, file)
	secretFree(t, "webp", out)
	if bytes.Contains(out, []byte("EXIF")) || bytes.Contains(out, []byte("XMP ")) {
		t.Fatalf("EXIF/XMP chunks must go")
	}
	if !bytes.Contains(out, image) || !bytes.Contains(out, []byte("ICCP")) {
		t.Fatalf("image and colour profile must stay")
	}
	if size := binary.LittleEndian.Uint32(out[4:8]); int(size) != len(out)-8 {
		t.Fatalf("RIFF size %d, want %d", size, len(out)-8)
	}
	flags := out[12+8] // first payload byte of the first chunk (VP8X)
	if flags&(0x08|0x04) != 0 || flags&0x20 == 0 {
		t.Fatalf("VP8X flags %08b: EXIF and XMP bits must clear, ICC must stay", flags)
	}
}

func TestPublicBoardCleansByContentNotExtension(t *testing.T) {
	f := newShareFixture(t)
	alice, _ := f.e.app.FindAuthRecordByEmail("users", "alice@x.gr")
	jpegDirty := withSegments(plainJPEG(t), seg(0xE1, exifPayload(1, false, "SECRET-JPE-GPS")))
	idJPE := f.e.uploadFile(f.aTok, map[string]string{"user_id": alice.Id, "project_id": f.projA}, "phone.jpe", "image/jpeg", jpegDirty)

	const sigAndIHDR = 8 + 12 + 13
	pngDirty := append([]byte{}, png1x1[:sigAndIHDR]...)
	pngDirty = append(pngDirty, pngChunk("eXIf", []byte("MM\x00*SECRET-PNG-GPS"))...)
	pngDirty = append(pngDirty, png1x1[sigAndIHDR:]...)
	idPNG := f.e.uploadFile(f.aTok, map[string]string{"user_id": alice.Id, "project_id": f.projA}, "shot.png", "image/png", pngDirty)
	f.set(t, map[string]any{"public": true})

	for name, id := range map[string]string{"jpe": idJPE, "png": idPNG} {
		w := f.e.raw("GET", "/api/mb/public/"+f.projA+"/files/"+id)
		if w.Code != 200 {
			t.Fatalf("%s: %d", name, w.Code)
		}
		secretFree(t, name, w.Body.Bytes())
	}
}

func TestStripImageMetaPNGAndWebPKeepRotation(t *testing.T) {
	// PNG: the eXIf chunk holds a bare TIFF block (no "Exif\0\0" prefix) with Orientation 6 and a secret.
	tiff := exifPayload(6, false, "SECRET-PNG-GPS")[6:]
	const sigAndIHDR = 8 + 12 + 13
	p := append([]byte{}, png1x1[:sigAndIHDR]...)
	p = append(p, pngChunk("eXIf", tiff)...)
	p = append(p, png1x1[sigAndIHDR:]...)
	out := strip(t, p)
	secretFree(t, "png rotation", out)
	want := pngChunk("eXIf", keptOrientation(6)[6:])
	if !bytes.Contains(out, want) {
		t.Fatalf("PNG must keep a minimal eXIf with orientation 6")
	}
	if _, err := png.Decode(bytes.NewReader(out)); err != nil {
		t.Fatalf("must decode: %v", err)
	}

	// WebP: EXIF chunk with the "Exif\0\0" prefix (some writers add it), Orientation 8.
	vp8x := []byte{0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	body := append([]byte("WEBP"), riffChunk("VP8X", vp8x)...)
	body = append(body, riffChunk("VP8L", []byte("image"))...)
	body = append(body, riffChunk("EXIF", exifPayload(8, true, "SECRET-WEBP-GPS"))...)
	file := append([]byte("RIFF\x00\x00\x00\x00"), body...)
	binary.LittleEndian.PutUint32(file[4:], uint32(len(body)))
	wout := strip(t, file)
	secretFree(t, "webp rotation", wout)
	if !bytes.Contains(wout, riffChunk("EXIF", keptOrientation(8)[6:])) {
		t.Fatalf("WebP must keep a minimal EXIF chunk with orientation 8")
	}
	if wout[12+8]&0x08 == 0 {
		t.Fatalf("the EXIF flag must stay set when an EXIF chunk is kept")
	}
	if int(binary.LittleEndian.Uint32(wout[4:8])) != len(wout)-8 {
		t.Fatalf("RIFF size wrong")
	}
	// No rotation in the EXIF: no EXIF chunk and a cleared flag.
	body2 := append([]byte("WEBP"), riffChunk("VP8X", vp8x)...)
	body2 = append(body2, riffChunk("VP8L", []byte("image"))...)
	body2 = append(body2, riffChunk("EXIF", exifPayload(1, false, "SECRET-WEBP-GPS"))...)
	file2 := append([]byte("RIFF\x00\x00\x00\x00"), body2...)
	binary.LittleEndian.PutUint32(file2[4:], uint32(len(body2)))
	w2 := strip(t, file2)
	if bytes.Contains(w2, []byte("EXIF")) || w2[12+8]&0x08 != 0 {
		t.Fatalf("orientation 1: no EXIF chunk, flag cleared")
	}
}
