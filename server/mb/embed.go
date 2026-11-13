package mb

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// EmbedConfig is the setup of the image embedder (Gemini embedContent). The key stays on the server.
type EmbedConfig struct {
	Key        string
	Model      string        // default gemini-embedding-2
	BaseURL    string        // default https://generativelanguage.googleapis.com
	Dim        int           // vector length; default 768. A different value re-embeds every image.
	DailyLimit int           // image embeds per user per UTC day; default 5000
	QueryLimit int           // search queries per user per UTC day; default 300
	Pause      time.Duration // wait after each image; default 300ms (the backfill is not in a hurry)
	RetryDelay time.Duration // wait before the single retry; default 5s
}

// Embedder computes one embedding per image of every user who switched on users.embed_enabled, and
// embeds search queries. Work runs in one background goroutine, one image at a time. The database
// says what is missing (a row with no vector, or made by another model or dimension), so a restart,
// a changed config or a new consent only needs a Backfill; nothing is kept in the queue that matters.
type Embedder struct {
	app    core.App
	cfg    EmbedConfig
	client *http.Client
	queue  chan string
	stop   chan struct{}
	wg     sync.WaitGroup

	mu   sync.Mutex
	used map[string]int // "<kind>|<user id>|<UTC date>" -> calls today
}

// embedders lets the routes and MCP tools find the embedder of their app.
var embedders sync.Map // core.App -> *Embedder

func embedderOf(app core.App) *Embedder {
	e, _ := embedders.Load(app)
	m, _ := e.(*Embedder)
	return m
}

var errEmbedSkip = errors.New("image not embedded") // unsupported type: not worth a warning

// EnableEmbeddings binds the embedder to new images, to the consent switch and to the server start.
// Call it from `serve` only.
func EnableEmbeddings(app core.App, cfg EmbedConfig) *Embedder {
	if cfg.Model == "" {
		cfg.Model = "gemini-embedding-2"
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://generativelanguage.googleapis.com"
	}
	if cfg.Dim == 0 {
		cfg.Dim = 768
	}
	if cfg.DailyLimit == 0 {
		cfg.DailyLimit = 5000
	}
	if cfg.QueryLimit == 0 {
		cfg.QueryLimit = 300
	}
	if cfg.Pause == 0 {
		cfg.Pause = 300 * time.Millisecond
	}
	if cfg.RetryDelay == 0 {
		cfg.RetryDelay = 5 * time.Second
	}
	m := &Embedder{
		app: app, cfg: cfg, client: &http.Client{Timeout: 60 * time.Second},
		queue: make(chan string, 64), stop: make(chan struct{}), used: map[string]int{},
	}
	go func() {
		for id := range m.queue {
			m.process(id)
			m.wg.Done()
		}
	}()
	embedders.Store(app, m)

	app.OnRecordAfterCreateSuccess("inspirations").BindFunc(func(e *core.RecordEvent) error {
		if m.consents(e.Record.GetString("user_id")) {
			m.enqueue(e.Record.Id)
		}
		return e.Next()
	})
	app.OnRecordAfterUpdateSuccess("inspirations").BindFunc(func(e *core.RecordEvent) error {
		// Only a replaced file needs a new vector; every other edit (and the colors save) does not.
		if e.Record.GetString("image") != e.Record.Original().GetString("image") && m.consents(e.Record.GetString("user_id")) {
			m.enqueue(e.Record.Id)
		}
		return e.Next()
	})
	app.OnRecordAfterUpdateSuccess("users").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetBool("embed_enabled") && !e.Record.Original().GetBool("embed_enabled") {
			m.wg.Add(1)
			go func() {
				defer m.wg.Done()
				m.Backfill()
			}()
		}
		return e.Next()
	})
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			m.Backfill()
		}()
		return se.Next()
	})
	app.Cron().MustAdd("mbEmbedBackfill", "7 * * * *", func() { m.Backfill() })
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		close(m.stop)
		m.wg.Wait()
		return e.Next()
	})
	return m
}

// Wait blocks until the queue and the running backfills are done (tests).
func (m *Embedder) Wait() { m.wg.Wait() }

func (m *Embedder) consents(uid string) bool {
	u, err := m.app.FindRecordById("users", uid)
	return err == nil && u.GetBool("embed_enabled")
}

func (m *Embedder) enqueue(id string) {
	m.wg.Add(1)
	select {
	case m.queue <- id:
	default: // full: the next Backfill finds it
		m.wg.Done()
	}
}

// enqueueWait waits for room in the queue. It reports false when the server is stopping.
func (m *Embedder) enqueueWait(id string) bool {
	m.wg.Add(1)
	select {
	case m.queue <- id:
		return true
	case <-m.stop:
		m.wg.Done()
		return false
	}
}

func (m *Embedder) day(kind, uid string) string {
	return kind + "|" + uid + "|" + time.Now().UTC().Format("2006-01-02")
}

func (m *Embedder) hasBudget(kind, uid string, limit int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.used[m.day(kind, uid)] < limit
}

func (m *Embedder) take(kind, uid string, limit int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := m.day(kind, uid)
	if m.used[k] >= limit {
		return false
	}
	m.used[k]++
	return true
}

// needs reports whether the image has no vector that matches the current model, dimension and file.
func (m *Embedder) needs(r *core.Record) bool {
	f, err := m.app.FindFirstRecordByData("image_features", "inspiration_id", r.Id)
	return err != nil || f.GetString("vec") == "" || f.GetString("model") != m.cfg.Model ||
		f.GetInt("dim") != m.cfg.Dim || f.GetString("image") != r.GetString("image")
}

// Backfill queues every image of every consenting user that lacks a current vector, and returns when
// all are queued (Wait waits for the work). It stops early when a user's daily budget is spent: the
// next hourly run continues.
func (m *Embedder) Backfill() {
	users, err := m.app.FindRecordsByFilter("users", "embed_enabled = true", "", 0, 0)
	if err != nil {
		m.app.Logger().Warn("embed backfill: list users failed", "error", err)
		return
	}
	for _, u := range users {
		recs, err := m.app.FindRecordsByFilter("inspirations", "user_id = {:u} && image != ''", "-created_at", 0, 0, map[string]any{"u": u.Id})
		if err != nil {
			m.app.Logger().Warn("embed backfill: list images failed", "error", err)
			continue
		}
		for _, r := range recs {
			if !m.hasBudget("img", u.Id, m.cfg.DailyLimit) {
				break
			}
			if m.needs(r) && !m.enqueueWait(r.Id) {
				return
			}
		}
	}
}

func (m *Embedder) process(id string) {
	err := m.embedOne(id)
	if err != nil && !errors.Is(err, errEmbedSkip) {
		m.app.Logger().Warn("embedding skipped", "inspiration", id, "error", err.Error())
		return
	}
	if err == nil {
		select {
		case <-m.stop:
		case <-time.After(m.cfg.Pause):
		}
	}
}

func (m *Embedder) embedOne(id string) error {
	select {
	case <-m.stop:
		return nil // the server is stopping: the next start finds the rest
	default:
	}
	r, err := m.app.FindRecordById("inspirations", id)
	if err != nil {
		return nil // deleted while it waited
	}
	uid, name := r.GetString("user_id"), r.GetString("image")
	if !m.consents(uid) || name == "" || !m.needs(r) {
		return nil
	}
	img, err := m.readThumb(r)
	if err != nil {
		return err
	}
	// Reading the thumbnail can wait for the shared slot: ask for the consent again just before the upload.
	if !m.consents(uid) {
		return nil
	}
	if !m.take("img", uid, m.cfg.DailyLimit) {
		return errAILimit
	}
	vec, err := m.embed([]any{
		map[string]any{"text": "title: none | text: "},
		map[string]any{"inline_data": map[string]any{"mime_type": img.mime, "data": img.b64}},
	})
	if err != nil {
		return err
	}
	// The user may have switched it off, deleted the image or replaced the file while we waited.
	if r, err = m.app.FindRecordById("inspirations", id); err != nil || r.GetString("image") != name || !m.consents(uid) {
		return nil
	}
	featMu.Lock()
	defer featMu.Unlock()
	f, err := featuresRow(m.app, r)
	if err != nil {
		return err
	}
	if f.GetString("image") != name { // a replaced file: the old hash belongs to the old picture
		f.Set("phash", "")
	}
	f.Set("image", name)
	f.Set("vec", encodeVec(vec))
	f.Set("model", m.cfg.Model)
	f.Set("dim", len(vec))
	f.IgnoreUnchangedFields(true)
	return m.app.Save(f)
}

// readThumb reads the 480 px thumbnail (the model needs no more) and checks its type.
func (m *Embedder) readThumb(r *core.Record) (aiImage, error) { return thumbImage(m.app, r, m.stop) }

// thumbImage reads the record's 480 px thumbnail (making it first) for a model call. A type the
// models do not read gives errEmbedSkip.
func thumbImage(app core.App, r *core.Record, done <-chan struct{}) (aiImage, error) {
	if _, err := ensureThumb(app, r, done); err != nil {
		return aiImage{}, err
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return aiImage{}, err
	}
	defer fsys.Close()
	rd, err := fsys.GetReader(thumbKeyOf(r))
	if err != nil {
		return aiImage{}, err
	}
	defer rd.Close()
	b, err := io.ReadAll(io.LimitReader(rd, suggestMaxBytes+1))
	if err != nil || len(b) > suggestMaxBytes {
		return aiImage{}, errors.New("thumbnail unreadable or too large")
	}
	img, err := newAIImage(b)
	if err != nil {
		return aiImage{}, fmt.Errorf("%w: %v", errEmbedSkip, err)
	}
	return img, nil
}

// EmbedQuery embeds a search text. It counts one call against the user's daily query budget.
func (m *Embedder) EmbedQuery(uid, q string) ([]float32, error) {
	if !m.take("query", uid, m.cfg.QueryLimit) {
		return nil, errAILimit
	}
	return m.embed([]any{map[string]any{"text": "task: search result | query: " + q}})
}

// embed sends one Content with the given parts (a single image or text, never several: Gemini would
// merge them into one vector) and returns the normalized vector.
func (m *Embedder) embed(parts []any) ([]float32, error) {
	body, _ := json.Marshal(map[string]any{
		"content":              map[string]any{"parts": parts},
		"outputDimensionality": m.cfg.Dim,
	})
	url := strings.TrimRight(m.cfg.BaseURL, "/") + "/v1beta/models/" + m.cfg.Model + ":embedContent"
	out, err := geminiPostRetry(m.client, m.cfg.Key, url, body, m.cfg.RetryDelay)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Embedding  struct{ Values []float64 }   `json:"embedding"`
		Embeddings []struct{ Values []float64 } `json:"embeddings"` // the SDK shape
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, errors.New("answer is not JSON")
	}
	vals := resp.Embedding.Values
	if len(vals) == 0 && len(resp.Embeddings) > 0 {
		vals = resp.Embeddings[0].Values
	}
	if len(vals) != m.cfg.Dim {
		return nil, fmt.Errorf("model returned %d numbers, want %d", len(vals), m.cfg.Dim)
	}
	return normalize(vals), nil
}

// normalize scales to unit length, so a dot product is the cosine similarity.
func normalize(v []float64) []float32 {
	var n float64
	for _, x := range v {
		n += x * x
	}
	n = math.Sqrt(n)
	out := make([]float32, len(v))
	if n == 0 {
		return out
	}
	for i, x := range v {
		out[i] = float32(x / n)
	}
	return out
}

func encodeVec(v []float32) string {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(x))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func decodeVec(s string) []float32 {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b)%4 != 0 || len(b) == 0 {
		return nil
	}
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[4*i:]))
	}
	return v
}
