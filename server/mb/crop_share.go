package mb

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"io"
	"math"
	"path"
	"strconv"
	"strings"

	"github.com/disintegration/imaging"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

// Cropped images on public boards. The crop is a rectangle stored on the row; the file in storage
// stays whole. A visitor of a public board must get the crop alone: the owner may have cut out a
// face, a name or a price, so the cropped-out pixels never leave this server. For each crop one
// cropped copy is made (inside the shared decode slot) and kept next to the original, under
// crops_<name>/; a new crop replaces it, and deleting the record deletes its folder.
// The image Worker never gets the bucket key of a cropped image (see handlePublicSrc), so it asks
// this server for the file and only resizes what it gets.

type cropRect struct{ X, Y, W, H float64 }

// cropOf is the record's crop, or nil when it shows the whole image.
func cropOf(r *core.Record) *cropRect {
	raw := r.GetString("crop")
	if raw == "" || raw == "null" || !validCrop(raw) {
		return nil
	}
	var c cropRect
	if json.Unmarshal([]byte(raw), &c) != nil {
		return nil
	}
	return &c
}

// maxCropPixels is the largest image (width x height) a public crop decodes; a larger one is not served.
var maxCropPixels = 40_000_000

// cropKeyOf is the storage key of the cropped copy, named after the exact crop values (two crops
// that differ only a little never share a copy). The extension follows the stored name; cropImage
// picks the encoding from the content, and storage records the real content type.
func cropKeyOf(r *core.Record, c *cropRect) string {
	name := r.GetString("image")
	ext := ".png"
	if e := strings.ToLower(path.Ext(name)); e == ".jpg" || e == ".jpeg" {
		ext = ".jpg"
	}
	f := func(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
	sum := sha256.Sum256([]byte(f(c.X) + "," + f(c.Y) + "," + f(c.W) + "," + f(c.H)))
	return r.BaseFilesPath() + "/crops_" + name + "/" + hex.EncodeToString(sum[:8]) + "_" + strings.TrimSuffix(name, path.Ext(name)) + ext
}

func cropThumbKeyOf(key string) string {
	dir, file := path.Split(key)
	return dir + "thumbs_" + file + "/" + shareThumb + "_" + file
}

// ensureCrop makes the cropped copy (and, with thumb, its 480x0 thumbnail) if missing, and returns
// the key to serve. "" means none could be made: the caller must not fall back to the original.
// Copies of earlier crops are removed by pruneCrops after the record changes, not here.
func ensureCrop(app core.App, fsys *filesystem.System, r *core.Record, c *cropRect, thumb bool, done <-chan struct{}) (string, error) {
	key := cropKeyOf(r, c)
	want := key
	if thumb {
		want = cropThumbKeyOf(key)
	}
	if ok, _ := fsys.Exists(want); ok {
		return want, nil
	}
	select {
	case thumbSlot <- struct{}{}:
	case <-done:
		return "", nil
	}
	defer func() { <-thumbSlot }()
	if ok, _ := fsys.Exists(key); !ok {
		body, err := cropImage(fsys, r.BaseFilesPath()+"/"+r.GetString("image"), c)
		if err != nil {
			return "", err
		}
		if err := fsys.Upload(body, key); err != nil {
			return "", err
		}
	}
	if thumb {
		if ok, _ := fsys.Exists(want); !ok {
			if err := thumbFits(fsys, key); err != nil {
				return "", err
			}
			if err := fsys.CreateThumb(key, want, shareThumb); err != nil {
				return "", err
			}
		}
	}
	return want, nil
}

// thumbFits refuses a 480x0 thumbnail that would hold more than maxCropPixels (a very thin crop).
func thumbFits(fsys *filesystem.System, key string) error {
	rd, err := fsys.GetReader(key)
	if err != nil {
		return err
	}
	defer rd.Close()
	cfg, _, err := image.DecodeConfig(rd)
	if err != nil {
		return err
	}
	if cfg.Width < 1 || float64(480)*480*float64(cfg.Height)/float64(cfg.Width) > float64(maxCropPixels) {
		return fmt.Errorf("thumbnail of a %dx%d crop is over the limit", cfg.Width, cfg.Height)
	}
	return nil
}

// cropImage decodes the original (on its full canvas, turned upright as a browser shows it), cuts
// the crop out and encodes it again. The new file holds no metadata.
func cropImage(fsys *filesystem.System, original string, c *cropRect) ([]byte, error) {
	rd, err := fsys.GetReader(original)
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(rd)
	rd.Close()
	if err != nil {
		return nil, err
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxCropPixels/cfg.Height {
		return nil, fmt.Errorf("image %dx%d is over the crop limit", cfg.Width, cfg.Height)
	}
	img, err := imaging.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	// A GIF frame may cover only part of its canvas; the crop is a fraction of the canvas.
	canvas := image.Rect(0, 0, cfg.Width, cfg.Height)
	if img.Bounds() != canvas {
		full := image.NewNRGBA(canvas)
		draw.Draw(full, img.Bounds(), img, img.Bounds().Min, draw.Src)
		img = full
	}
	img = upright(img, orientationOf(raw))
	b := img.Bounds()
	w, h := float64(b.Dx()), float64(b.Dy())
	px := func(v, size float64, lo int) int { return lo + int(math.Round(math.Min(math.Max(v, 0), 1)*size)) }
	rect := image.Rect(px(c.X, w, b.Min.X), px(c.Y, h, b.Min.Y), px(c.X+c.W, w, b.Min.X), px(c.Y+c.H, h, b.Min.Y))
	if rect.Dx() < 1 || rect.Dy() < 1 {
		return nil, fmt.Errorf("crop %v is empty on a %dx%d image", *c, b.Dx(), b.Dy())
	}
	out := imaging.Crop(img, rect)
	var buf bytes.Buffer
	if format == "jpeg" {
		err = imaging.Encode(&buf, out, imaging.JPEG, imaging.JPEGQuality(90))
	} else { // by content, not name: a transparent GIF or WebP keeps its alpha
		err = imaging.Encode(&buf, out, imaging.PNG)
	}
	return buf.Bytes(), err
}

// upright applies an Exif Orientation (2..8) the way a browser does.
func upright(img image.Image, o int) image.Image {
	switch o {
	case 2:
		return imaging.FlipH(img)
	case 3:
		return imaging.Rotate180(img)
	case 4:
		return imaging.FlipV(img)
	case 5:
		return imaging.Transpose(img)
	case 6:
		return imaging.Rotate270(img)
	case 7:
		return imaging.Transverse(img)
	case 8:
		return imaging.Rotate90(img)
	}
	return img
}

// orientationOf reads the Exif Orientation of a JPEG (first Exif APP1 that has one), PNG (eXIf) or
// WebP (EXIF chunk), the same tags stripmeta keeps; 0 when absent.
func orientationOf(b []byte) int {
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8}):
		for i := 2; i+4 <= len(b) && b[i] == 0xFF; {
			if b[i+1] == 0xFF { // fill byte before the marker
				i++
				continue
			}
			m := b[i+1]
			if m == 0xDA || m == 0xD9 { // image data: no more metadata segments
				return 0
			}
			n := int(b[i+2])<<8 | int(b[i+3])
			if n < 2 || i+2+n > len(b) {
				return 0
			}
			if m == 0xE1 {
				if o := exifOrientation(b[i+4 : i+2+n]); o != 0 {
					return o
				}
			}
			i += 2 + n
		}
	case bytes.HasPrefix(b, pngSig):
		if c := pngRotationChunk(b, len(pngSig)); len(c) > 12 {
			return tiffOrientation(c[8 : len(c)-4])
		}
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		for i := 12; i+8 <= len(b); {
			n := int(binary.LittleEndian.Uint32(b[i+4 : i+8]))
			if n < 0 || i+8+n > len(b) {
				return 0
			}
			if string(b[i:i+4]) == "EXIF" {
				return tiffOrientation(b[i+8 : i+8+n])
			}
			i += 8 + n + n%2
		}
	}
	return 0
}

// pruneCrops removes the stored copies of every crop but the record's current one.
func pruneCrops(app core.App, r *core.Record) error {
	r, err := app.FindRecordById(r.Collection(), r.Id) // the latest crop, not the one when the change was queued
	if err != nil {
		return nil // deleted: its folder goes with it
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return err
	}
	defer fsys.Close()
	objs, err := fsys.List(r.BaseFilesPath() + "/crops_")
	if err != nil {
		return err
	}
	keep, keepThumbs := "", ""
	if c := cropOf(r); c != nil {
		keep = cropKeyOf(r, c)
		keepThumbs = path.Dir(cropThumbKeyOf(keep)) + "/"
	}
	for _, o := range objs {
		// Only files inside a crops_<name>/ folder; an uploaded original may itself be named crops_*.
		if !strings.Contains(strings.TrimPrefix(o.Key, r.BaseFilesPath()+"/"), "/") {
			continue
		}
		if keep != "" && (o.Key == keep || strings.HasPrefix(o.Key, keepThumbs)) {
			continue
		}
		if err := fsys.Delete(o.Key); err != nil {
			return err
		}
	}
	return nil
}

// regionsInCrop moves the regions (fractions of the whole image) into fractions of the crop, and
// drops the ones that fall fully outside it (a polygon by its own shape, not its bounding box).
func regionsInCrop(raw any, c *cropRect) []map[string]any {
	b, _ := json.Marshal(raw)
	var in []map[string]any
	_ = json.Unmarshal(b, &in)
	out := make([]map[string]any, 0, len(in))
	num := func(m map[string]any, k string) float64 { v, _ := m[k].(float64); return v }
	for _, reg := range in {
		x, y := (num(reg, "x")-c.X)/c.W, (num(reg, "y")-c.Y)/c.H
		w, h := num(reg, "w")/c.W, num(reg, "h")/c.H
		const eps = 1e-9 // a region that only touches the crop's edge is outside
		if x+w <= eps || y+h <= eps || x >= 1-eps || y >= 1-eps {
			continue
		}
		reg["x"], reg["y"], reg["w"], reg["h"] = x, y, w, h
		if pts, ok := reg["points"].([]any); ok {
			var poly [][2]float64
			for _, p := range pts {
				if xy, ok := p.([]any); ok && len(xy) == 2 {
					px, _ := xy[0].(float64)
					py, _ := xy[1].(float64)
					xy[0], xy[1] = (px-c.X)/c.W, (py-c.Y)/c.H
					poly = append(poly, [2]float64{xy[0].(float64), xy[1].(float64)})
				}
			}
			if len(poly) >= 3 && !polygonMeetsUnitSquare(poly) {
				continue
			}
		}
		out = append(out, reg)
	}
	return out
}

// polygonMeetsUnitSquare tells whether a polygon overlaps the open square (0,1)x(0,1): a vertex or
// an edge's middle inside it, a corner of it inside the polygon, or two edges that cross.
func polygonMeetsUnitSquare(poly [][2]float64) bool {
	const eps = 1e-9
	inside := func(p [2]float64) bool { return p[0] > eps && p[0] < 1-eps && p[1] > eps && p[1] < 1-eps }
	for i, p := range poly {
		q := poly[(i+1)%len(poly)]
		// a vertex inside, or the middle of an edge (a chord between two points on the square's sides)
		if inside(p) || inside([2]float64{(p[0] + q[0]) / 2, (p[1] + q[1]) / 2}) {
			return true
		}
	}
	sq := [][2]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}}
	const in = 1e-6 // corners moved just inside: a polygon that only touches a corner or an edge does not count
	for _, q := range [][2]float64{{in, in}, {1 - in, in}, {1 - in, 1 - in}, {in, 1 - in}} {
		if pointInPolygon(q, poly) {
			return true
		}
	}
	for i := range poly {
		a, b := poly[i], poly[(i+1)%len(poly)]
		for j := range sq {
			if segmentsCross(a, b, sq[j], sq[(j+1)%4]) {
				return true
			}
		}
	}
	return false
}

func pointInPolygon(q [2]float64, poly [][2]float64) bool {
	in := false
	for i, j := 0, len(poly)-1; i < len(poly); j, i = i, i+1 {
		a, b := poly[i], poly[j]
		if (a[1] > q[1]) != (b[1] > q[1]) && q[0] < (b[0]-a[0])*(q[1]-a[1])/(b[1]-a[1])+a[0] {
			in = !in
		}
	}
	return in
}

// segmentsCross is true when the two segments cross at a point inside both (touching is not crossing).
func segmentsCross(a, b, c, d [2]float64) bool {
	side := func(p, q, r [2]float64) float64 { return (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0]) }
	const eps = 1e-12
	d1, d2 := side(c, d, a), side(c, d, b)
	d3, d4 := side(a, b, c), side(a, b, d)
	return (d1 > eps && d2 < -eps || d1 < -eps && d2 > eps) && (d3 > eps && d4 < -eps || d3 < -eps && d4 > eps)
}
