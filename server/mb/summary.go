package mb

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// A draft of a project's description, made only when the owner presses the button. The model looks
// at a sample of the project's images together and writes the description as parts: text it is sure
// of, and "choices" (2 or 3 readings) where it is not. The owner picks the readings that fit, edits
// the text and saves it as projects.description (the public board shows it). The server stores
// nothing: a draft lives in the page.

const (
	summaryImages    = 8   // images of the project sent with one request
	summaryNotes     = 10  // notes of the owner sent as context
	summaryNoteChars = 200 // per note
	summaryTags      = 15
	summaryMaxParts  = 30
	summaryTextMax   = 400
	summaryChoiceMax = 200
)

type draftPart struct {
	Text    string   `json:"text,omitempty"`
	Choices []string `json:"choices,omitempty"`
}

func bindSummaryRoutes(g *router.RouterGroup[*core.RequestEvent]) {
	g.POST("/projects/{id}/summary-draft", handleSummaryDraft)
}

// PickDiverse returns the indexes of up to k vectors (unit length) that cover the set: the first one,
// then each time the vector farthest, by 1 - cosine, from all chosen. A tie goes to the lowest index.
func PickDiverse(vecs [][]float32, k int) []int {
	if len(vecs) == 0 || k < 1 {
		return []int{}
	}
	k = min(k, len(vecs))
	chosen := []int{0}
	minD := make([]float64, len(vecs)) // distance to the nearest chosen vector
	update := func(from int) {
		for i, v := range vecs {
			var dot float32
			for j, x := range vecs[from] {
				dot += x * v[j]
			}
			if d := 1 - float64(dot); len(chosen) == 1 || d < minD[i] {
				minD[i] = d
			}
		}
	}
	update(0)
	for len(chosen) < k {
		best, bestD := -1, -1.0
		for i := range vecs {
			if minD[i] > bestD && !contains(chosen, i) {
				best, bestD = i, minD[i]
			}
		}
		chosen = append(chosen, best)
		update(best)
	}
	return chosen
}

func contains(xs []int, x int) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// pickSample chooses the images to show the model: the most different ones when the project's
// images have vectors, else evenly spaced ones.
func pickSample(app core.App, uid string, recs []*core.Record, k int) []*core.Record {
	if len(recs) <= k {
		return recs
	}
	if ix, err := userIdx(app, uid); err == nil {
		vecs := make([][]float32, len(recs))
		ok := true
		for i, r := range recs {
			j, found := ix.byID[r.Id]
			if !found || ix.entries[j].vec == nil || (i > 0 && len(ix.entries[j].vec) != len(vecs[0])) {
				ok = false
				break
			}
			vecs[i] = ix.entries[j].vec
		}
		if ok {
			out := make([]*core.Record, 0, k)
			for _, i := range PickDiverse(vecs, k) {
				out = append(out, recs[i])
			}
			return out
		}
	}
	out := make([]*core.Record, k)
	for i := range out {
		out[i] = recs[i*len(recs)/k]
	}
	return out
}

func handleSummaryDraft(e *core.RequestEvent) error {
	p, err := e.App.FindRecordById("projects", e.Request.PathValue("id"))
	if err != nil || p.GetString("user_id") != e.Auth.Id {
		return e.Error(http.StatusNotFound, tr(e.Request, "Το project δεν βρέθηκε.", "Project not found."), nil)
	}
	v, _ := labelers.Load(e.App)
	l, _ := v.(*Labeler)
	// Either consent covers it: both say the user's images go to Google Gemini.
	if l == nil || !(e.Auth.GetBool("ai_enabled") || e.Auth.GetBool("embed_enabled")) {
		return e.JSON(http.StatusOK, map[string]any{"enabled": false, "parts": []draftPart{}})
	}
	uid := e.Auth.Id
	recs, err := e.App.FindRecordsByFilter("inspirations", "user_id = {:u} && project_id = {:p} && image != ''", "-created_at", 0, 0,
		map[string]any{"u": uid, "p": p.Id})
	if err != nil {
		return e.InternalServerError("", err)
	}
	if len(recs) == 0 {
		return e.BadRequestError(tr(e.Request, "Το project δεν έχει εικόνες.", "The project has no images."), nil)
	}

	parts := []any{map[string]any{"text": summaryPrompt(e, p, recs)}}
	imgs := 0
	for _, r := range pickSample(e.App, uid, recs, summaryImages) {
		img, err := thumbImage(e.App, r, e.Request.Context().Done())
		if err != nil {
			continue // a type the model does not read, or a broken file: use the others
		}
		parts = append(parts, map[string]any{"inline_data": map[string]any{"mime_type": img.mime, "data": img.b64}})
		imgs++
	}
	if imgs == 0 {
		return e.BadRequestError(tr(e.Request, "Καμία εικόνα του project δεν διαβάζεται από το μοντέλο.", "No image of the project can be read by the model."), nil)
	}
	if !l.take(uid) {
		return e.Error(http.StatusTooManyRequests, "daily limit reached", nil)
	}
	text, err := l.generateJSON(parts, draftSchema())
	if err != nil {
		e.App.Logger().Warn("summary draft failed", "error", err.Error())
		return e.Error(http.StatusBadGateway, "model failed", nil)
	}
	draft, err := parseDraft(text)
	if err != nil {
		e.App.Logger().Warn("summary draft rejected", "error", err.Error())
		return e.Error(http.StatusBadGateway, "model answer unusable", nil)
	}
	return e.JSON(http.StatusOK, map[string]any{"enabled": true, "parts": draft})
}

func draftSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{"parts": map[string]any{
			"type": "array", "maxItems": summaryMaxParts,
			"items": map[string]any{"type": "object", "properties": map[string]any{
				"text":    map[string]any{"type": "string"},
				"choices": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "minItems": 2, "maxItems": 3},
			}},
		}},
		"required": []string{"parts"},
	}
}

// parseDraft checks the model's answer: every part has either text or 2-3 choices, and the sizes
// are bounded, so the page can show it without trusting the model.
func parseDraft(text string) ([]draftPart, error) {
	var d struct {
		Parts []draftPart `json:"parts"`
	}
	if err := json.Unmarshal([]byte(text), &d); err != nil {
		return nil, errors.New("answer is not JSON")
	}
	if len(d.Parts) == 0 || len(d.Parts) > summaryMaxParts {
		return nil, fmt.Errorf("%d parts", len(d.Parts))
	}
	parts := d.Parts[:0]
	for i := range d.Parts {
		pt := d.Parts[i]
		pt.Text = strings.TrimRight(pt.Text, "\x00")
		// A lone space between two choices is real text. A part with nothing in it is noise: drop it.
		hasText, hasChoices := pt.Text != "", len(pt.Choices) > 0
		if !hasText && !hasChoices {
			continue
		}
		if hasText && hasChoices {
			return nil, fmt.Errorf("part %d has both text and choices", i)
		}
		if utf8.RuneCountInString(pt.Text) > summaryTextMax {
			return nil, fmt.Errorf("part %d text too long", i)
		}
		if hasChoices {
			if len(pt.Choices) < 2 || len(pt.Choices) > 3 {
				return nil, fmt.Errorf("part %d has %d choices", i, len(pt.Choices))
			}
			for _, c := range pt.Choices {
				if strings.TrimSpace(c) == "" || utf8.RuneCountInString(c) > summaryChoiceMax {
					return nil, fmt.Errorf("part %d has an unusable choice", i)
				}
			}
		}
		parts = append(parts, pt)
	}
	if len(parts) == 0 {
		return nil, errors.New("no usable parts")
	}
	return parts, nil
}

// summaryPrompt is the instruction plus what the owner wrote about the project. Only this user's
// project is read.
func summaryPrompt(e *core.RequestEvent, p *core.Record, recs []*core.Record) string {
	lang := "Greek"
	if isEnglish(e.Request) {
		lang = "English"
	}
	counts := map[string]int{}
	var notes []string
	for _, r := range recs {
		for _, t := range stringList(r.Get("tags")) {
			counts[t]++
		}
		if n := strings.TrimSpace(r.GetString("note")); n != "" && len(notes) < summaryNotes {
			if utf8.RuneCountInString(n) > summaryNoteChars {
				n = string([]rune(n)[:summaryNoteChars]) + "…"
			}
			notes = append(notes, "- "+n)
		}
	}
	tags := make([]string, 0, len(counts))
	for t := range counts {
		tags = append(tags, t)
	}
	sort.Slice(tags, func(i, j int) bool {
		if counts[tags[i]] != counts[tags[j]] {
			return counts[tags[i]] > counts[tags[j]]
		}
		return tags[i] < tags[j]
	})
	if len(tags) > summaryTags {
		tags = tags[:summaryTags]
	}
	for i, t := range tags {
		tags[i] = fmt.Sprintf("%s ×%d", t, counts[t])
	}
	return "You help an architect describe one moodboard project. Below are the project's name and description, " +
		"a sample of its images, its most used tags with counts, and some of the owner's notes.\n" +
		"Write a description of 3 to 5 sentences about what unites these images: subject, style, materials, mood, use. " +
		"Use only what the images, tags and notes show.\n" +
		"Answer as JSON {\"parts\": [...]}. Read the parts in order to get the description. A part has either \"text\" " +
		"(what you are sure of) or \"choices\" (2 or 3 different wordings or readings of something you are not sure of: " +
		"the style, a detail, who it is for). Make every choice fit the words around it, so any combination reads well. " +
		"Use at most 4 parts with choices.\n" +
		"Write in " + lang + ".\n\n" +
		"Project: " + p.GetString("name") + "\n" +
		"Description: " + p.GetString("description") + "\n" +
		fmt.Sprintf("Images in the project: %d (a sample of %d follows)\n", len(recs), min(len(recs), summaryImages)) +
		"Tags: " + strings.Join(tags, ", ") + "\n" +
		"Notes:\n" + strings.Join(notes, "\n")
}
