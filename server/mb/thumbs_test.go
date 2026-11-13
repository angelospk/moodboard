package mb_test

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"moodboard/server/mb"
)

// thumbKey is the storage key of the 480x0 thumbnail of the record's image.
func thumbKey(r *core.Record) string {
	name := r.GetString("image")
	return r.BaseFilesPath() + "/thumbs_" + name + "/480x0_" + name
}

func (e *env) thumbExists(r *core.Record) bool {
	e.t.Helper()
	fsys, err := e.app.NewFilesystem()
	if err != nil {
		e.t.Fatal(err)
	}
	defer fsys.Close()
	ok, _ := fsys.Exists(thumbKey(r))
	return ok
}

func (e *env) dropThumb(r *core.Record) {
	e.t.Helper()
	fsys, err := e.app.NewFilesystem()
	if err != nil {
		e.t.Fatal(err)
	}
	defer fsys.Close()
	if err := fsys.Delete(thumbKey(r)); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) uploaded(tok string, fields map[string]string) *core.Record {
	e.t.Helper()
	code, out := e.upload(tok, fields)
	if code != 200 {
		e.t.Fatalf("upload: %d %s", code, out)
	}
	var row struct{ Id string }
	_ = json.Unmarshal([]byte(out), &row)
	r, err := e.app.FindRecordById("inspirations", row.Id)
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

func TestUploadMakesThumbOnce(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r := e.uploaded(tok, map[string]string{"user_id": u.Id})
	mb.WaitThumbs()
	if !e.thumbExists(r) {
		t.Fatal("upload did not make the 480x0 thumbnail")
	}
}

func TestBrokenImageStillUploads(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	saved := png1x1
	png1x1 = append(append([]byte{}, png1x1[:40]...), []byte("broken")...)
	defer func() { png1x1 = saved }()
	code, out := e.upload(tok, map[string]string{"user_id": u.Id})
	mb.WaitThumbs()
	if code != 200 {
		t.Fatalf("a thumbnail failure must not fail the upload: %d %s", code, out)
	}
	var row struct{ Id string }
	_ = json.Unmarshal([]byte(out), &row)
	r, _ := e.app.FindRecordById("inspirations", row.Id)
	ft, _ := u.NewFileToken()
	// The on-demand path also fails; it serves the original without a second decode attempt
	// (PocketBase sets ThumbError only when it tries a thumbnail itself).
	var pbTried error
	e.app.OnFileDownloadRequest().BindFunc(func(fe *core.FileDownloadRequestEvent) error {
		pbTried = fe.ThumbError
		return fe.Next()
	})
	w := e.raw("GET", "/api/files/"+r.Collection().Id+"/"+r.Id+"/"+r.GetString("image")+"?thumb=480x0&token="+ft)
	if w.Code != 200 || !strings.HasSuffix(w.Body.String(), "broken") || e.thumbExists(r) || pbTried != nil {
		t.Fatalf("broken image thumb request: %d, PocketBase thumb error %v", w.Code, pbTried)
	}
}

// A request for a missing thumbnail waits for the shared slot, so a burst cannot decode in parallel.
func TestOnDemandThumbWaitsForSlot(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r := e.uploaded(tok, map[string]string{"user_id": u.Id})
	mb.WaitThumbs()
	e.dropThumb(r)
	ft, err := u.NewFileToken()
	if err != nil {
		t.Fatal(err)
	}
	url := "/api/files/" + r.Collection().Id + "/" + r.Id + "/" + r.GetString("image") + "?thumb=480x0&token=" + ft

	release := mb.HoldThumbSlot()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- e.raw("GET", url) }()
	select {
	case <-done:
		release()
		t.Fatal("the thumbnail request did not wait for the busy slot")
	case <-time.After(300 * time.Millisecond):
	}
	release()
	w := <-done
	if w.Code != 200 || !strings.HasPrefix(w.Body.String(), "\x89PNG") || !e.thumbExists(r) {
		t.Fatalf("after the slot is free: %d, thumb exists %v", w.Code, e.thumbExists(r))
	}

	// Without a valid token the middleware does nothing and PocketBase answers 404.
	e.dropThumb(r)
	bad := strings.Replace(url, "token="+ft, "token=x", 1)
	if w := e.raw("GET", bad); w.Code != 404 || e.thumbExists(r) {
		t.Fatalf("no token: %d, thumb exists %v", w.Code, e.thumbExists(r))
	}
}

func TestBackfillThumbs(t *testing.T) {
	e := newEnv(t)
	u, tok := e.user("a@x.gr")
	r1 := e.uploaded(tok, map[string]string{"user_id": u.Id})
	r2 := e.uploaded(tok, map[string]string{"user_id": u.Id})
	mb.WaitThumbs()
	e.dropThumb(r1)
	if n := mb.BackfillThumbs(e.app, 0, nil); n != 1 {
		t.Fatalf("backfill made %d thumbs, want 1", n)
	}
	if !e.thumbExists(r1) || !e.thumbExists(r2) {
		t.Fatal("thumbs missing after backfill")
	}
	if n := mb.BackfillThumbs(e.app, 0, nil); n != 0 {
		t.Fatalf("second backfill made %d thumbs, want 0", n)
	}
}
