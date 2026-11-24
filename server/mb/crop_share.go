package mb

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"math"
	"path"
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

// cropKeyOf is the storage key of the cropped copy. PNG stays PNG (it may be transparent); every
// other format becomes JPEG.
func cropKeyOf(r *core.Record, c *cropRect) string {
	name := r.GetString("image")
	ext := ".jpg"
	if strings.EqualFold(path.Ext(name), ".png") {
		ext = ".png"
	}
	q := func(v float64) int { return int(math.Round(v * 10000)) }
	tag := fmt.Sprintf("%d_%d_%d_%d", q(c.X), q(c.Y), q(c.W), q(c.H))
	return r.BaseFilesPath() + "/crops_" + name + "/" + tag + "_" + strings.TrimSuffix(name, path.Ext(name)) + ext
}

func cropThumbKeyOf(key string) string {
	dir, file := path.Split(key)
	return dir + "thumbs_" + file + "/" + shareThumb + "_" + file
}

// ensureCrop makes the cropped copy (and, with thumb, its 480x0 thumbnail) if missing, and returns
// the key to serve. "" means none could be made: the caller must not fall back to the original.
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
		body, err := cropImage(fsys, r.BaseFilesPath()+"/"+r.GetString("image"), c, path.Ext(key) == ".png")
		if err != nil {
			return "", err
		}
		// One crop at a time: copies of earlier crops go.
		_ = fsys.DeletePrefix(path.Dir(key) + "/")
		if err := fsys.Upload(body, key); err != nil {
			return "", err
		}
	}
	if thumb {
		if ok, _ := fsys.Exists(want); !ok {
			if err := fsys.CreateThumb(key, want, shareThumb); err != nil {
				return "", err
			}
		}
	}
	return want, nil
}

// cropImage decodes the original (turned upright, as a browser shows it), cuts the crop out and
// encodes it again. The new file holds no metadata.
func cropImage(fsys *filesystem.System, original string, c *cropRect, asPNG bool) ([]byte, error) {
	rd, err := fsys.GetReader(original)
	if err != nil {
		return nil, err
	}
	defer rd.Close()
	img, err := imaging.Decode(rd, imaging.AutoOrientation(true))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	w, h := float64(b.Dx()), float64(b.Dy())
	px := func(v, size float64, lo int) int { return lo + int(math.Round(math.Min(math.Max(v, 0), 1)*size)) }
	rect := image.Rect(px(c.X, w, b.Min.X), px(c.Y, h, b.Min.Y), px(c.X+c.W, w, b.Min.X), px(c.Y+c.H, h, b.Min.Y))
	if rect.Dx() < 1 || rect.Dy() < 1 {
		return nil, fmt.Errorf("crop %v is empty on a %dx%d image", *c, b.Dx(), b.Dy())
	}
	out := imaging.Crop(img, rect)
	var buf bytes.Buffer
	if asPNG {
		err = imaging.Encode(&buf, out, imaging.PNG)
	} else {
		err = imaging.Encode(&buf, out, imaging.JPEG, imaging.JPEGQuality(90))
	}
	return buf.Bytes(), err
}

// regionsInCrop moves the regions (fractions of the whole image) into fractions of the crop, and
// drops the ones that fall fully outside it.
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
			for _, p := range pts {
				if xy, ok := p.([]any); ok && len(xy) == 2 {
					px, _ := xy[0].(float64)
					py, _ := xy[1].(float64)
					xy[0], xy[1] = (px-c.X)/c.W, (py-c.Y)/c.H
				}
			}
		}
		out = append(out, reg)
	}
	return out
}
