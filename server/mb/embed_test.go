package mb_test

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"moodboard/server/mb"
)

// fakeEmbed stands in for the embedContent endpoint. An image gets the vector (r, g, b) of its mean
// color; a query gets a unit vector for the first of "red", "green", "blue" it contains. Vectors are
// padded with zeros to the requested outputDimensionality and normalized, like the real API does.
// The answer has the real shape {"embedding": {"values": [...]}}.
type fakeEmbed struct {
	srv      *httptest.Server
	mu       sync.Mutex
	calls    []geminiCall
	statuses []int
}

func newFakeEmbed(t *testing.T) *fakeEmbed {
	t.Helper()
	f := &fakeEmbed{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.calls = append(f.calls, geminiCall{r.URL.Path, r.Header.Get("x-goog-api-key"), string(b)})
		status := 200
		if len(f.statuses) > 0 {
			status, f.statuses = f.statuses[0], f.statuses[1:]
		}
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != 200 {
			_, _ = w.Write([]byte(`{"error":{"message":"fake failure"}}`))
			return
		}
		var req struct {
			Content struct {
				Parts []struct {
					Text       string `json:"text"`
					InlineData *struct {
						Data string `json:"data"`
					} `json:"inline_data"`
				} `json:"parts"`
			} `json:"content"`
			Dim int `json:"outputDimensionality"`
		}
		_ = json.Unmarshal(b, &req)
		v := []float64{1, 1, 1}
		for _, p := range req.Content.Parts {
			switch {
			case p.InlineData != nil:
				raw, _ := base64.StdEncoding.DecodeString(p.InlineData.Data)
				v = meanColor(raw)
			case strings.Contains(p.Text, "red"):
				v = []float64{1, 0, 0}
			case strings.Contains(p.Text, "green"):
				v = []float64{0, 1, 0}
			case strings.Contains(p.Text, "blue"):
				v = []float64{0, 0, 1}
			}
		}
		dim := req.Dim
		if dim == 0 {
			dim = 3072
		}
		vals := make([]float64, dim)
		var n float64
		for i := range vals {
			if i < len(v) {
				vals[i] = v[i]
			}
			n += vals[i] * vals[i]
		}
		for i := range vals {
			vals[i] /= math.Sqrt(n)
		}
		out, _ := json.Marshal(map[string]any{"embedding": map[string]any{"values": vals}})
		_, _ = w.Write(out)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func meanColor(png []byte) []float64 {
	img, _, err := image.Decode(bytes.NewReader(png))
	if err != nil {
		return []float64{1, 1, 1}
	}
	var r, g, b, n float64
	bd := img.Bounds()
	for y := bd.Min.Y; y < bd.Max.Y; y++ {
		for x := bd.Min.X; x < bd.Max.X; x++ {
			c := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
			if c.A < 128 {
				continue
			}
			r, g, b, n = r+float64(c.R), g+float64(c.G), b+float64(c.B), n+1
		}
	}
	if n == 0 {
		return []float64{1, 1, 1}
	}
	return []float64{r / n, g / n, b / n}
}

func (f *fakeEmbed) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeEmbed) last() geminiCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

const testDim = 8

func embedEnv(t *testing.T, f *fakeEmbed, cfg mb.EmbedConfig) (*env, *mb.Embedder) {
	t.Helper()
	e := newEnv(t)
	cfg.Key, cfg.Model, cfg.BaseURL = "test-key", "embed-test", f.srv.URL
	if cfg.Dim == 0 {
		cfg.Dim = testDim
	}
	cfg.Pause, cfg.RetryDelay = time.Nanosecond, time.Millisecond
	return e, mb.EnableEmbeddings(e.app, cfg)
}

func (e *env) setEmbed(uid string, on bool) {
	e.t.Helper()
	u, err := e.app.FindRecordById("users", uid)
	if err != nil {
		e.t.Fatal(err)
	}
	u.Set("embed_enabled", on)
	if err := e.app.Save(u); err != nil {
		e.t.Fatal(err)
	}
}

// vecOf decodes the stored vector of an inspiration (nil when there is none).
func (e *env) vecOf(id string) []float32 {
	e.t.Helper()
	f := e.featuresOf(id)
	if f == nil || f.GetString("vec") == "" {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(f.GetString("vec"))
	if err != nil {
		e.t.Fatal(err)
	}
	out := make([]float32, len(raw)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return out
}

func (e *env) settle(emb *mb.Embedder) {
	mb.WaitThumbs()
	emb.Wait()
}

var (
	red    = color.RGBA{255, 0, 0, 255}
	orange = color.RGBA{255, 100, 0, 255}
	blue   = color.RGBA{0, 0, 255, 255}
	green  = color.RGBA{0, 255, 0, 255}
)

func TestEmbedNeedsConsent(t *testing.T) {
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	e.setAI(u.Id, true) // the label consent is not enough
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, red))
	e.settle(emb)
	if f.count() != 0 || e.vecOf(r.Id) != nil {
		t.Fatalf("no embed consent: %d calls", f.count())
	}
}

func TestEmbedStoresVectorOnUpload(t *testing.T) {
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	e.setEmbed(u.Id, true)
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, red))
	e.settle(emb)

	if f.count() != 1 {
		t.Fatalf("want one call, got %d", f.count())
	}
	c := f.last()
	if c.path != "/v1beta/models/embed-test:embedContent" || c.key != "test-key" {
		t.Fatalf("call: %s key %s", c.path, c.key)
	}
	var body struct {
		Content struct {
			Parts []map[string]any `json:"parts"`
		} `json:"content"`
		Dim       int    `json:"outputDimensionality"`
		TaskType  string `json:"taskType"`
		TaskType2 string `json:"task_type"`
	}
	_ = json.Unmarshal([]byte(c.body), &body)
	if body.Dim != testDim || body.TaskType != "" || body.TaskType2 != "" {
		t.Fatalf("body: %s", c.body)
	}
	if len(body.Content.Parts) != 2 || body.Content.Parts[0]["text"] != "title: none | text: " || body.Content.Parts[1]["inline_data"] == nil {
		t.Fatalf("one image part after the document prefix, got %s", c.body)
	}
	v := e.vecOf(r.Id)
	if len(v) != testDim || math.Abs(float64(v[0])-1) > 1e-5 {
		t.Fatalf("vector: %v", v)
	}
	row := e.featuresOf(r.Id)
	if row.GetString("model") != "embed-test" || row.GetInt("dim") != testDim || row.GetString("phash") == "" {
		t.Fatalf("row: model %q dim %d phash %q", row.GetString("model"), row.GetInt("dim"), row.GetString("phash"))
	}
}

func TestEmbedConsentBackfillsOldImagesOnce(t *testing.T) {
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	bob, bTok := e.user("b@x.gr")
	e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, red))
	e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, blue))
	e.uploadImage(bTok, map[string]string{"user_id": bob.Id}, solid(16, 16, green)) // never consents
	e.settle(emb)
	if f.count() != 0 {
		t.Fatalf("before consent: %d calls", f.count())
	}

	e.setEmbed(u.Id, true) // the switch starts the backfill
	e.settle(emb)
	if f.count() != 2 {
		t.Fatalf("after consent: want 2 calls (Alice's two), got %d", f.count())
	}
	emb.Backfill()
	e.settle(emb)
	if f.count() != 2 {
		t.Fatalf("second backfill must make no call, total %d", f.count())
	}
	// Saving other fields of the user must not start a backfill.
	e.setAI(u.Id, true)
	e.settle(emb)
	if f.count() != 2 {
		t.Fatalf("unrelated user update called the API: %d", f.count())
	}
}

func TestEmbedReEmbedsWhenModelOrDimChanges(t *testing.T) {
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	e.setEmbed(u.Id, true)
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, red))
	e.settle(emb)
	row := e.featuresOf(r.Id)
	row.Set("dim", 4) // as if an older config had made it
	if err := e.app.Save(row); err != nil {
		t.Fatal(err)
	}
	emb.Backfill()
	e.settle(emb)
	if f.count() != 2 || e.featuresOf(r.Id).GetInt("dim") != testDim {
		t.Fatalf("calls %d dim %d", f.count(), e.featuresOf(r.Id).GetInt("dim"))
	}
}

func TestEmbedStopsAtDailyLimit(t *testing.T) {
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, mb.EmbedConfig{DailyLimit: 2})
	u, tok := e.user("a@x.gr")
	e.setEmbed(u.Id, true)
	for _, c := range []color.RGBA{red, blue, green} {
		e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, c))
	}
	e.settle(emb)
	if f.count() != 2 {
		t.Fatalf("limit 2: got %d calls", f.count())
	}
}

func TestEmbedRetriesOnceOn429(t *testing.T) {
	f := newFakeEmbed(t)
	f.statuses = []int{429, 200}
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	e.setEmbed(u.Id, true)
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, red))
	e.settle(emb)
	if f.count() != 2 || e.vecOf(r.Id) == nil {
		t.Fatalf("calls %d vector %v", f.count(), e.vecOf(r.Id))
	}
}

func TestEmbedFailureNeverBreaksUpload(t *testing.T) {
	f := newFakeEmbed(t)
	f.statuses = []int{500, 500}
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	e.setEmbed(u.Id, true)
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, red))
	e.settle(emb)
	if e.vecOf(r.Id) != nil {
		t.Fatal("no vector expected")
	}
	if _, err := e.app.FindRecordById("inspirations", r.Id); err != nil {
		t.Fatal(err)
	}
}

func TestEmbedderAndLocalFeaturesShareOneRow(t *testing.T) {
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	e.setEmbed(u.Id, true)
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, solid(16, 16, red))
	e.settle(emb)
	if e.featuresOf(r.Id).GetString("phash") == "" || e.vecOf(r.Id) == nil {
		t.Fatal("embedder and local features must both end up on the one row")
	}
}

// A replaced file gets a new vector. The old hash and colors belong to the old file, so they must be
// computed again: the row must not look fresh just because the embedder moved the file name on.
func TestEmbedReplacingTheFileClearsTheOldHash(t *testing.T) {
	f := newFakeEmbed(t)
	e, emb := embedEnv(t, f, mb.EmbedConfig{})
	u, tok := e.user("a@x.gr")
	r := e.uploadImage(tok, map[string]string{"user_id": u.Id}, gradient(32, 32, false))
	row := e.featuresOf(r.Id)
	if row.GetString("phash") == "" {
		t.Fatal("setup: the hash must exist")
	}
	row.Set("image", "an-older-file.png")
	if err := e.app.Save(row); err != nil {
		t.Fatal(err)
	}
	e.setEmbed(u.Id, true)
	e.settle(emb)
	row = e.featuresOf(r.Id)
	if row.GetString("image") != r.GetString("image") || e.vecOf(r.Id) == nil {
		t.Fatal("the embedder must have moved the row to the current file")
	}
	if row.GetString("phash") != "" {
		t.Fatalf("the hash of the old file was kept: %q", row.GetString("phash"))
	}
}
