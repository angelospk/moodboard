package mb

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// AIConfig is the setup of the automatic labeler (Gemini vision). The key stays on the server.
type AIConfig struct {
	Key        string
	Model      string        // default gemini-3.5-flash-lite
	BaseURL    string        // default https://generativelanguage.googleapis.com
	DailyLimit int           // images per user per UTC day; default 100
	RetryDelay time.Duration // wait before the single retry; default 5s
}

// Labeler suggests a level and tags for every new image of a user who switched AI on
// (users.ai_enabled). It writes only the `suggestion` field; the user accepts or dismisses it in
// the web app. Work runs in one background goroutine, one image at a time, so a burst of uploads
// cannot exhaust the small VPS or the shared Gemini quota. A failure drops the suggestion and never
// affects saving. The queue lives in memory: images pending at a restart are not labeled.
type Labeler struct {
	app    core.App
	cfg    AIConfig
	client *http.Client
	queue  chan string
	wg     sync.WaitGroup

	mu   sync.Mutex
	used map[string]int // "<user id>|<UTC date>" -> calls today

	slots chan struct{} // concurrent /suggest requests (each holds up to a few MB while it runs)
}

const (
	suggestMaxBytes = 4 << 20 // clients send a ~1024px JPEG; anything bigger just gets no prefill
	suggestSlots    = 3
)

const aiMaxTags = 5

// EnableAI binds the labeler to new inspirations and returns it. Call it from `serve` only
// (an import must not label thousands of rows).
func EnableAI(app core.App, cfg AIConfig) *Labeler {
	if cfg.Model == "" {
		cfg.Model = "gemini-3.5-flash-lite"
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://generativelanguage.googleapis.com"
	}
	if cfg.DailyLimit == 0 {
		cfg.DailyLimit = 100
	}
	if cfg.RetryDelay == 0 {
		cfg.RetryDelay = 5 * time.Second
	}
	l := &Labeler{
		app: app, cfg: cfg, client: &http.Client{Timeout: 60 * time.Second},
		queue: make(chan string, 64), used: map[string]int{}, slots: make(chan struct{}, suggestSlots),
	}
	go func() {
		for id := range l.queue {
			l.process(id)
			l.wg.Done()
		}
	}()
	labelers.Store(app, l)
	app.OnRecordAfterCreateSuccess("inspirations").BindFunc(func(e *core.RecordEvent) error {
		// Opt-in is checked now, not only when the worker runs: an image saved while AI was off must
		// never be sent because the user switched it on while it waited in the queue.
		if u, err := app.FindRecordById("users", e.Record.GetString("user_id")); err == nil && u.GetBool("ai_enabled") {
			l.enqueue(e.Record.Id)
		}
		return e.Next()
	})
	return l
}

// labelers lets the /api/mb/suggest route (bound in Register) find the labeler of its app.
var labelers sync.Map // core.App -> *Labeler

// Wait blocks until the queue is empty (tests).
func (l *Labeler) Wait() { l.wg.Wait() }

func (l *Labeler) enqueue(id string) {
	l.wg.Add(1)
	select {
	case l.queue <- id:
	default: // queue full: drop it, the image stays unlabeled
		l.wg.Done()
	}
}

// hasBudget reports whether the user can still make a call today (without using it).
func (l *Labeler) hasBudget(uid string) bool {
	k := uid + "|" + time.Now().UTC().Format("2006-01-02")
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.used[k] < l.cfg.DailyLimit
}

// take counts one call against the user's daily budget.
func (l *Labeler) take(uid string) bool {
	k := uid + "|" + time.Now().UTC().Format("2006-01-02")
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.used[k] >= l.cfg.DailyLimit {
		return false
	}
	l.used[k]++
	return true
}

func (l *Labeler) process(id string) {
	if err := l.label(id); err != nil {
		l.app.Logger().Warn("ai labeling skipped", "inspiration", id, "error", err.Error())
	}
}

type aiAnswer struct {
	Level string   `json:"level"`
	Tags  []string `json:"tags"`
}

func (l *Labeler) label(id string) error {
	r, err := l.app.FindRecordById("inspirations", id)
	if err != nil {
		return err
	}
	uid := r.GetString("user_id")
	u, err := l.app.FindRecordById("users", uid)
	if err != nil || !u.GetBool("ai_enabled") {
		return nil
	}
	if hasSuggestion(r) || r.GetString("level") != "" && len(stringList(r.Get("tags"))) > 0 {
		return nil
	}
	img, err := l.readImage(r)
	if err != nil {
		return err
	}
	level, tags, err := l.suggest(uid, img)
	if err != nil {
		return err
	}
	sg := map[string]any{"level": nilIfEmpty(level), "tags": tags}
	// Re-read: the user may have labeled it while we waited. Write only this field.
	if r, err = l.app.FindRecordById("inspirations", id); err != nil || hasSuggestion(r) {
		return err
	}
	r.Set("suggestion", sg)
	r.IgnoreUnchangedFields(true)
	return l.app.Save(r)
}

var (
	errAILimit    = errors.New("daily limit reached")
	errAINoAnswer = errors.New("answer had no usable level or tags")
)

// suggest asks the model about one image of user uid. It returns the user's level id (or "") and up
// to aiMaxTags cleaned tags. It counts one call against the user's daily budget.
func (l *Labeler) suggest(uid string, img aiImage) (string, []string, error) {
	if !l.take(uid) {
		return "", nil, errAILimit
	}
	levels := listLevels(l.app, uid)
	names := make([]string, 0, len(levels))
	for _, lv := range levels {
		names = append(names, lv["name"].(string))
	}
	known, _ := UserTags(l.app, uid)
	if len(known) > 80 {
		known = known[:80]
	}
	ans, err := l.ask(img, names, known)
	if err != nil {
		return "", nil, err
	}
	level := ""
	if ans.Level != "" {
		if lv, err := resolveLevel(l.app, uid, ans.Level); err == nil {
			level = lv.Id
		}
	}
	tags := CleanTags(ans.Tags)
	if len(tags) > aiMaxTags {
		tags = tags[:aiMaxTags]
	}
	if level == "" && len(tags) == 0 {
		return "", nil, errAINoAnswer
	}
	return level, tags, nil
}

type aiImage struct{ mime, b64 string }

func (l *Labeler) readImage(r *core.Record) (aiImage, error) {
	fsys, err := l.app.NewFilesystem()
	if err != nil {
		return aiImage{}, err
	}
	defer fsys.Close()
	rd, err := fsys.GetReader(r.BaseFilesPath() + "/" + r.GetString("image"))
	if err != nil {
		return aiImage{}, err
	}
	defer rd.Close()
	b, err := io.ReadAll(io.LimitReader(rd, maxImageBytes+1))
	if err != nil || len(b) > maxImageBytes {
		return aiImage{}, errors.New("image unreadable or too large")
	}
	return newAIImage(b)
}

// newAIImage checks that b is an image and prepares it for the request.
func newAIImage(b []byte) (aiImage, error) {
	mt := http.DetectContentType(b)
	if mt != "image/png" && mt != "image/jpeg" && mt != "image/webp" { // the formats Gemini reads (no gif, avif)
		return aiImage{}, fmt.Errorf("type %s not sent to the model", mt)
	}
	return aiImage{mime: mt, b64: base64.StdEncoding.EncodeToString(b)}, nil
}

func (l *Labeler) ask(img aiImage, levels, known []string) (aiAnswer, error) {
	prompt := "You label inspiration images saved by an architect. Look at the image and answer in JSON.\n" +
		"level: the one level that fits best, exactly as written. Levels: " + strings.Join(levels, ", ") + ".\n" +
		"tags: at most 5 short, lowercase tags (one or two words, same language as the user's tags). " +
		"Reuse a tag from the user's list when it fits; add a new one only when none does. " +
		"Never use a level name as a tag. " +
		"The user's tags, most used first: " + strings.Join(known, ", ") + "."
	levelSchema := map[string]any{"type": "string"}
	if len(levels) > 0 {
		levelSchema["enum"] = levels
	}
	body, _ := json.Marshal(map[string]any{
		"contents": []any{map[string]any{"parts": []any{
			map[string]any{"text": prompt},
			map[string]any{"inline_data": map[string]any{"mime_type": img.mime, "data": img.b64}},
		}}},
		"generationConfig": map[string]any{
			"responseMimeType": "application/json",
			"responseJsonSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"level": levelSchema,
					"tags":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": aiMaxTags},
				},
				"required": []string{"level", "tags"},
			},
		},
	})
	url := strings.TrimRight(l.cfg.BaseURL, "/") + "/v1beta/models/" + l.cfg.Model + ":generateContent"

	var out []byte
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			time.Sleep(l.cfg.RetryDelay)
		}
		var retry bool
		if out, retry, err = l.post(url, body); err == nil || !retry {
			break
		}
	}
	if err != nil {
		return aiAnswer{}, err
	}
	var resp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(out, &resp); err != nil || len(resp.Candidates) == 0 || len(resp.Candidates[0].Content.Parts) == 0 {
		return aiAnswer{}, errors.New("no candidate in the answer")
	}
	var ans aiAnswer
	if err := json.Unmarshal([]byte(resp.Candidates[0].Content.Parts[0].Text), &ans); err != nil {
		return aiAnswer{}, fmt.Errorf("answer is not JSON: %w", err)
	}
	return ans, nil
}

// post sends one request. retry is true for a network error, 429 and 5xx.
func (l *Labeler) post(url string, body []byte) (out []byte, retry bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", l.cfg.Key) // header, not ?key=, so it never lands in a log
	res, err := l.client.Do(req)
	if err != nil {
		return nil, true, errors.New("request failed") // the error text can hold the URL; keep it short
	}
	defer res.Body.Close()
	out, _ = io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return nil, res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500, fmt.Errorf("gemini status %d", res.StatusCode)
	}
	return out, false, nil
}

// handleSuggest answers {enabled, level, tags} for one image the client has not saved yet (the
// extension popup, quick add, upload form), so the form can prefill. It stores nothing. Status:
// 200 (enabled false when the user or the server has AI off), 400 not an image, 413 too large,
// 429 daily limit, 503 too many at once, 502 model failed; clients treat any non-200 as "no prefill".
func handleSuggest(e *core.RequestEvent) error {
	v, _ := labelers.Load(e.App)
	l, _ := v.(*Labeler)
	if l == nil || !e.Auth.GetBool("ai_enabled") {
		return e.JSON(http.StatusOK, map[string]any{"enabled": false})
	}
	// Cheap refusals first, before any body is read: over budget, or all slots busy.
	if !l.hasBudget(e.Auth.Id) {
		return e.Error(http.StatusTooManyRequests, "daily limit reached", nil)
	}
	select {
	case l.slots <- struct{}{}:
		defer func() { <-l.slots }()
	default:
		return e.Error(http.StatusServiceUnavailable, "busy, try again", nil)
	}
	e.Request.Body = http.MaxBytesReader(e.Response, e.Request.Body, suggestMaxBytes+(1<<20))
	f, _, err := e.Request.FormFile("image")
	if err != nil {
		return e.Error(http.StatusRequestEntityTooLarge, "image missing or too large", nil)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, suggestMaxBytes+1))
	if err != nil || len(b) > suggestMaxBytes {
		return e.Error(http.StatusRequestEntityTooLarge, "image too large", nil)
	}
	img, err := newAIImage(b)
	if err != nil {
		return e.BadRequestError("not an image", nil)
	}
	level, tags, err := l.suggest(e.Auth.Id, img)
	switch {
	case errors.Is(err, errAILimit):
		return e.Error(http.StatusTooManyRequests, "daily limit reached", nil)
	case err != nil:
		e.App.Logger().Warn("ai suggest failed", "error", err.Error())
		return e.Error(http.StatusBadGateway, "model failed", nil)
	}
	return e.JSON(http.StatusOK, map[string]any{"enabled": true, "level": level, "tags": tags})
}
