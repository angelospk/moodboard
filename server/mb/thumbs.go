package mb

import (
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// Thumbnails. Decoding a large PNG takes a lot of memory, and the VPS has 1 GB. So every 480x0
// thumbnail this package makes waits for one shared slot: uploads, the public board, the files
// route and the backfill never decode two images at once. An upload makes its thumbnail in the
// background, so opening a board later only reads small files.

// thumbSlot is the global semaphore of 1 for thumbnail decoding.
var thumbSlot = make(chan struct{}, 1)

// thumbJobs tracks the background thumbnails of uploads (the tests wait for them).
var thumbJobs sync.WaitGroup

// thumbKeyOf is the storage key of the 480x0 thumbnail of the record's image.
func thumbKeyOf(r *core.Record) string {
	name := r.GetString("image")
	return r.BaseFilesPath() + "/thumbs_" + name + "/" + shareThumb + "_" + name
}

// ensureThumb makes the record's 480x0 thumbnail if it is missing, inside the shared slot.
// done is closed (e.g. a request context) to stop waiting for the slot. It reports whether a
// thumbnail was made.
func ensureThumb(app core.App, r *core.Record, done <-chan struct{}) (bool, error) {
	name := r.GetString("image")
	if name == "" {
		return false, nil
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return false, err
	}
	defer fsys.Close()
	thumb := thumbKeyOf(r)
	if ok, _ := fsys.Exists(thumb); ok {
		return false, nil
	}
	select {
	case thumbSlot <- struct{}{}:
	case <-done:
		return false, nil
	}
	defer func() { <-thumbSlot }()
	// Another request may have made it while this one waited.
	if ok, _ := fsys.Exists(thumb); ok {
		return false, nil
	}
	if err := fsys.CreateThumb(r.BaseFilesPath()+"/"+name, thumb, shareThumb); err != nil {
		return false, err
	}
	return true, nil
}

// bindThumbs makes the thumbnail of a new or changed image in the background (a failure is only
// logged: the upload has already succeeded) and runs the backfill once when the server starts.
// At terminate it stops queued work and waits for the running decode, before the app closes its DB.
func bindThumbs(app core.App) {
	stop := make(chan struct{})
	var once sync.Once
	run := func(f func()) {
		thumbJobs.Add(1)
		go func() {
			defer thumbJobs.Done()
			f()
		}()
	}
	after := func(e *core.RecordEvent) error {
		a, r := e.App, e.Record.Fresh()
		run(func() {
			if _, err := ensureThumb(a, r, stop); err != nil {
				a.Logger().Warn("thumbnail after upload failed", "record", r.Id, "error", err)
			}
		})
		return e.Next()
	}
	app.OnRecordAfterCreateSuccess("inspirations").BindFunc(after)
	app.OnRecordAfterUpdateSuccess("inspirations").BindFunc(after)
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		run(func() { BackfillThumbs(se.App, 2*time.Second, stop) })
		return se.Next()
	})
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		once.Do(func() { close(stop) })
		thumbJobs.Wait()
		return e.Next()
	})
}

// thumbOnDemand runs before PocketBase's files route. When the owner asks for a missing 480x0
// thumbnail of an inspiration (valid file token), it makes it inside the shared slot; PocketBase
// then serves the existing file. Every other request passes through unchanged.
func thumbOnDemand(e *core.RequestEvent) error {
	q := e.Request.URL.Query()
	parts := strings.Split(strings.TrimPrefix(e.Request.URL.Path, "/api/files/"), "/")
	if q.Get("thumb") != shareThumb || len(parts) != 3 || !strings.HasPrefix(e.Request.URL.Path, "/api/files/") {
		return e.Next()
	}
	c, err := e.App.FindCachedCollectionByNameOrId(parts[0])
	if err != nil || c.Name != "inspirations" {
		return e.Next()
	}
	auth, err := e.App.FindAuthRecordByToken(q.Get("token"), core.TokenTypeFile)
	if err != nil {
		return e.Next()
	}
	r, err := e.App.FindRecordById(c, parts[1])
	if err != nil || r.GetString("image") != parts[2] || r.GetString("user_id") != auth.Id {
		return e.Next()
	}
	if _, err := ensureThumb(e.App, r, e.Request.Context().Done()); err != nil {
		// Serve the original: without this, PocketBase would decode the image again outside the slot.
		e.App.Logger().Warn("thumbnail on demand failed", "record", r.Id, "error", err)
		q.Del("thumb")
		e.Request.URL.RawQuery = q.Encode()
	}
	return e.Next()
}

// BackfillThumbs makes the missing 480x0 thumbnails of all inspirations, one at a time, with a
// pause after each one it makes, until stop is closed. It returns how many it made. It runs once in
// the background at start; when nothing is missing it only checks that the files exist.
func BackfillThumbs(app core.App, pause time.Duration, stop <-chan struct{}) int {
	recs, err := app.FindRecordsByFilter("inspirations", "image != ''", "", 0, 0)
	if err != nil {
		app.Logger().Warn("thumbnail backfill: list failed", "error", err)
		return 0
	}
	made := 0
	for _, r := range recs {
		select {
		case <-stop:
			return made
		default:
		}
		ok, err := ensureThumb(app, r, stop)
		if err != nil {
			app.Logger().Warn("thumbnail backfill failed", "record", r.Id, "error", err)
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
		app.Logger().Info("thumbnail backfill done", "made", made)
	}
	return made
}
