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
}

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
		queue: make(chan string, 64), used: map[string]int{},
	}
	go func() {
		for id := range l.queue {
			l.process(id)
			l.wg.Done()
		}
	}()
	app.OnRecordAfterCreateSuccess("inspirations").BindFunc(func(e *core.RecordEvent) error {
		l.enqueue(e.Record.Id)
		return e.Next()
	})
	return l
}

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
	if !l.take(uid) {
		return errors.New("daily limit reached")
	}

	img, err := l.readImage(r)
	if err != nil {
		return err
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
		return err
	}
	sg := map[string]any{"level": nil, "tags": []string{}}
	if lv, err := resolveLevel(l.app, uid, ans.Level); err == nil && ans.Level != "" {
		sg["level"] = lv.Id
	}
	tags := CleanTags(ans.Tags)
	if len(tags) > aiMaxTags {
		tags = tags[:aiMaxTags]
	}
	sg["tags"] = tags
	if sg["level"] == nil && len(tags) == 0 {
		return errors.New("answer had no usable level or tags")
	}
	// Re-read: the user may have labeled it while we waited. Write only this field.
	if r, err = l.app.FindRecordById("inspirations", id); err != nil || hasSuggestion(r) {
		return err
	}
	r.Set("suggestion", sg)
	r.IgnoreUnchangedFields(true)
	return l.app.Save(r)
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
	mt := http.DetectContentType(b)
	if !strings.HasPrefix(mt, "image/") {
		return aiImage{}, fmt.Errorf("type %s not sent to the model", mt)
	}
	return aiImage{mime: mt, b64: base64.StdEncoding.EncodeToString(b)}, nil
}

func (l *Labeler) ask(img aiImage, levels, known []string) (aiAnswer, error) {
	prompt := "You label inspiration images saved by an architect. Look at the image and answer in JSON.\n" +
		"level: the one level that fits best, exactly as written. Levels: " + strings.Join(levels, ", ") + ".\n" +
		"tags: at most 5 short, lowercase tags (one or two words, same language as the user's tags). " +
		"Reuse a tag from the user's list when it fits; add a new one only when none does. " +
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
