package mb

import (
	"fmt"
	"image"
	"image/color"
	"io"
	"math"
	"math/bits"
	"sort"
	"strconv"
	"sync"
	"time"

	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"github.com/pocketbase/pocketbase/core"
	_ "golang.org/x/image/webp"
)

// Local features of an image: dominant colors and a perceptual hash. No network, no AI. They are
// computed from the 480x0 thumbnail, so a decode costs little memory.

const maxColors = 5

// AnalyzeImage decodes an image and returns up to five dominant colors ("#rrggbb", most common
// first) and its 64-bit difference hash.
func AnalyzeImage(r io.Reader) ([]string, uint64, error) {
	colors, hash, _, err := analyze(r)
	return colors, hash, err
}

// analyze is AnalyzeImage plus whether the picture is flat (one tone, no shapes to compare).
func analyze(r io.Reader) (colors []string, hash uint64, flat bool, err error) {
	img, _, err := image.Decode(r)
	if err != nil {
		return nil, 0, false, err
	}
	hash, flat = dHash(img)
	return dominantColors(img), hash, flat, nil
}

type bucket struct {
	n       int
	r, g, b int // sums
}

func (b *bucket) mean() (int, int, int) { return b.r / b.n, b.g / b.n, b.b / b.n }

func dist2(r1, g1, b1, r2, g2, b2 int) int {
	return (r1-r2)*(r1-r2) + (g1-g2)*(g1-g2) + (b1-b2)*(b1-b2)
}

// dominantColors groups the pixels in 4096 buckets (4 bits per channel), then merges buckets that
// are close, so a soft gradient gives one color and not twenty. Transparent pixels are ignored.
func dominantColors(img image.Image) []string {
	bd := img.Bounds()
	step := 1
	if m := max(bd.Dx(), bd.Dy()); m > 128 {
		step = m / 128
	}
	buckets := map[int]*bucket{}
	total := 0
	for y := bd.Min.Y; y < bd.Max.Y; y += step {
		for x := bd.Min.X; x < bd.Max.X; x += step {
			c := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
			if c.A < 128 {
				continue
			}
			k := int(c.R>>4)<<8 | int(c.G>>4)<<4 | int(c.B>>4)
			b := buckets[k]
			if b == nil {
				b = &bucket{}
				buckets[k] = b
			}
			b.n++
			b.r += int(c.R)
			b.g += int(c.G)
			b.b += int(c.B)
			total++
		}
	}
	if total == 0 {
		return []string{}
	}
	all := make([]*bucket, 0, len(buckets))
	for _, b := range buckets {
		all = append(all, b)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].n != all[j].n {
			return all[i].n > all[j].n
		}
		return all[i].r+all[i].g+all[i].b > all[j].r+all[j].g+all[j].b // stable order for equal counts
	})
	const merge = 40 * 40 // colors closer than 40 (of 441) in RGB are one color
	var chosen []*bucket
	for _, b := range all {
		br, bg, bb := b.mean()
		var near *bucket
		for _, c := range chosen {
			cr, cg, cb := c.mean()
			if dist2(br, bg, bb, cr, cg, cb) < merge {
				near = c
				break
			}
		}
		switch {
		case near != nil:
			near.n += b.n
			near.r += b.r
			near.g += b.g
			near.b += b.b
		case len(chosen) < maxColors:
			c := *b
			chosen = append(chosen, &c)
		}
	}
	sort.SliceStable(chosen, func(i, j int) bool { return chosen[i].n > chosen[j].n })
	out := make([]string, 0, len(chosen))
	for _, c := range chosen {
		if c.n*50 < total { // under 2% of the picture
			continue
		}
		r, g, b := c.mean()
		out = append(out, fmt.Sprintf("#%02x%02x%02x", r, g, b))
	}
	return out
}

// flatRange is the brightness spread (of 255) under which a picture has no shapes to hash.
const flatRange = 6

// dHash is the difference hash: the picture as 9x8 gray cells (box average, transparent = white),
// one bit for each "left cell is brighter than the right one". Size and small edits change few bits.
// flat is true when the cells differ by less than flatRange: every flat picture would hash alike.
func dHash(img image.Image) (hash uint64, flat bool) {
	bd := img.Bounds()
	w, h := bd.Dx(), bd.Dy()
	var cell [8][9]float64
	for cy := 0; cy < 8; cy++ {
		y0, y1 := bd.Min.Y+cy*h/8, bd.Min.Y+(cy+1)*h/8
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for cx := 0; cx < 9; cx++ {
			x0, x1 := bd.Min.X+cx*w/9, bd.Min.X+(cx+1)*w/9
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var sum float64
			n := 0
			for y := y0; y < y1 && y < bd.Max.Y; y++ {
				for x := x0; x < x1 && x < bd.Max.X; x++ {
					c := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
					a := float64(c.A) / 255
					lum := 0.299*float64(c.R) + 0.587*float64(c.G) + 0.114*float64(c.B)
					sum += lum*a + 255*(1-a)
					n++
				}
			}
			if n > 0 {
				cell[cy][cx] = sum / float64(n)
			}
		}
	}
	lo, hi := cell[0][0], cell[0][0]
	for cy := 0; cy < 8; cy++ {
		for cx := 0; cx < 9; cx++ {
			lo, hi = math.Min(lo, cell[cy][cx]), math.Max(hi, cell[cy][cx])
		}
	}
	for cy := 0; cy < 8; cy++ {
		for cx := 0; cx < 8; cx++ {
			hash <<= 1
			if cell[cy][cx] > cell[cy][cx+1] {
				hash |= 1
			}
		}
	}
	return hash, hi-lo < flatRange
}

func hamming(a, b uint64) int { return bits.OnesCount64(a ^ b) }

func hashHex(h uint64) string { return fmt.Sprintf("%016x", h) }

// flatHash is stored in image_features.phash for a flat picture: it is "done" but never a duplicate.
const flatHash = "flat"

func parseHash(s string) (uint64, bool) {
	h, err := strconv.ParseUint(s, 16, 64)
	return h, err == nil && len(s) == 16
}

// featuresRow returns the image_features row of an inspiration, or a new unsaved one.
func featuresRow(app core.App, r *core.Record) (*core.Record, error) {
	if f, err := app.FindFirstRecordByData("image_features", "inspiration_id", r.Id); err == nil {
		return f, nil
	}
	c, err := app.FindCachedCollectionByNameOrId("image_features")
	if err != nil {
		return nil, err
	}
	f := core.NewRecord(c)
	f.Set("inspiration_id", r.Id)
	f.Set("user_id", r.GetString("user_id"))
	return f, nil
}

// featuresFresh reports whether the colors and the hash already describe the record's image.
func featuresFresh(app core.App, r *core.Record) bool {
	f, err := app.FindFirstRecordByData("image_features", "inspiration_id", r.Id)
	if err != nil || f.GetString("image") != r.GetString("image") || f.GetString("phash") == "" {
		return false
	}
	// "[]" counts: a fully transparent image has no colors, and must not be recomputed on every save
	// (saving the record fires the update hook again).
	c := r.GetString("colors")
	return c != "" && c != "null"
}

// featMu serializes writes to image_features rows: the local features and the embedder both update
// the same row, and each must keep the other's fields.
var featMu sync.Mutex

func saveFeatures(app core.App, r *core.Record, name, phash string) error {
	featMu.Lock()
	defer featMu.Unlock()
	f, err := featuresRow(app, r)
	if err != nil {
		return err
	}
	if f.GetString("image") != name { // a replaced file: the old vector no longer fits
		f.Set("vec", "")
		f.Set("model", "")
		f.Set("dim", 0)
	}
	f.Set("image", name)
	f.Set("phash", phash)
	f.IgnoreUnchangedFields(true)
	return app.Save(f)
}

// ensureFeatures computes the colors and the hash of the record's image when they are missing or
// stale. It reads the thumbnail (making it first, inside the shared slot). It reports whether it
// computed them. An image with no readable thumbnail gives an error and no row.
func ensureFeatures(app core.App, r *core.Record, done <-chan struct{}) (bool, error) {
	name := r.GetString("image")
	if name == "" || featuresFresh(app, r) {
		return false, nil
	}
	if _, err := ensureThumb(app, r, done); err != nil {
		return false, err
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return false, err
	}
	defer fsys.Close()
	rd, err := fsys.GetReader(thumbKeyOf(r))
	if err != nil {
		return false, err // no thumbnail yet (stopped while waiting for the slot) or unsupported format
	}
	defer rd.Close()
	colors, hash, flat, err := analyze(rd)
	if err != nil {
		return false, err
	}
	phash := hashHex(hash)
	if flat {
		phash = flatHash
	}
	// Re-read: the user may have edited the record while we decoded. A replaced file makes this result
	// old (its own job follows); write only the colors.
	if r, err = app.FindRecordById("inspirations", r.Id); err != nil {
		return false, err
	}
	if r.GetString("image") != name {
		return false, nil
	}
	if err := saveFeatures(app, r, name, phash); err != nil {
		return false, err
	}
	r.Set("colors", colors)
	r.IgnoreUnchangedFields(true)
	return true, app.Save(r)
}

// BackfillFeatures computes the missing colors and hashes of all inspirations, one at a time, with
// a pause after each one it makes, until stop is closed (nil = never). It returns how many it made.
func BackfillFeatures(app core.App, pause time.Duration, stop <-chan struct{}) int {
	recs, err := app.FindRecordsByFilter("inspirations", "image != ''", "", 0, 0)
	if err != nil {
		app.Logger().Warn("features backfill: list failed", "error", err)
		return 0
	}
	made := 0
	for _, r := range recs {
		select {
		case <-stop:
			return made
		default:
		}
		ok, err := ensureFeatures(app, r, stop)
		if err != nil {
			app.Logger().Warn("features backfill failed", "record", r.Id, "error", err)
		}
		if !ok {
			continue
		}
		made++
		select {
		case <-stop:
			return made
		case <-time.After(pause):
		}
	}
	if made > 0 {
		app.Logger().Info("features backfill done", "made", made)
	}
	return made
}
