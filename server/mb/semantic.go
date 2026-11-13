package mb

import (
	"errors"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// Search by meaning, similar images, near-duplicates and label suggestions from neighbours. All of
// it reads the image_features rows through an in-memory index of one user: a brute-force dot
// product over unit vectors (10 000 images x 768 numbers is about 30 MB and a few milliseconds).

const (
	dupMaxDistance = 6    // bits of 64 that may differ for "the same picture"
	dupMaxPairs    = 200  // pairs returned by /duplicates
	knnK           = 15   // labeled neighbours that vote
	knnPool        = 60   // nearest images looked at to find knnK labeled ones
	knnSharp       = 20.0 // a neighbour 0.05 less similar than the best one counts e^-1 as much
	knnTagMin      = 0.35 // share of the vote a tag needs
	knnLevelMin    = 0.4
	knnMinVotes    = 2 // a label seen on one neighbour only is not a pattern
	idxMaxUsers    = 8 // cached users; more clears the cache
)

type vecEntry struct {
	id, project string
	vec         []float32 // nil when not embedded yet
	hash        uint64
	hasHash     bool
}

type userIndex struct {
	entries []vecEntry
	byID    map[string]int
}

type hit struct {
	ID    string  `json:"id"`
	Score float64 `json:"score"`
}

// The key is the user id alone: a hook gets another core.App value than a request does (a wrapper
// or the transaction), so the app cannot be part of it. Ids are random and unique.
var idxCache = struct {
	sync.Mutex
	m map[string]*userIndex
}{m: map[string]*userIndex{}}

// idxGen counts the invalidations. An index built while one happened may hold old data: it answers
// the request that built it, but it is not cached.
var idxGen uint64

// idxBuildHook runs between the index query and the caching (tests only).
var idxBuildHook func()

func dropIndex(uid string) {
	idxCache.Lock()
	delete(idxCache.m, uid)
	idxGen++
	idxCache.Unlock()
}

// userIdx returns the cached index of a user, building it when there is none.
func userIdx(app core.App, uid string) (*userIndex, error) {
	idxCache.Lock()
	ix := idxCache.m[uid]
	gen := idxGen
	idxCache.Unlock()
	if ix != nil {
		return ix, nil
	}
	var rows []struct {
		Id        string `db:"id"`
		Project   string `db:"project"`
		Vec       string `db:"vec"`
		Phash     string `db:"phash"`
		Model     string `db:"model"`
		FeatImage string `db:"feat_image"`
		Image     string `db:"image"`
	}
	err := app.DB().NewQuery(`SELECT f.inspiration_id AS id, COALESCE(i.project_id, '') AS project, f.vec AS vec, f.phash AS phash,
		f.model AS model, f.image AS feat_image, i.image AS image
		FROM image_features f JOIN inspirations i ON i.id = f.inspiration_id WHERE f.user_id = {:u}`).
		Bind(dbx.Params{"u": uid}).All(&rows)
	if err != nil {
		return nil, err
	}
	if idxBuildHook != nil {
		idxBuildHook()
	}
	model := ""
	if m := embedderOf(app); m != nil {
		model = m.cfg.Model
	}
	ix = &userIndex{entries: make([]vecEntry, 0, len(rows)), byID: make(map[string]int, len(rows))}
	for _, r := range rows {
		en := vecEntry{id: r.Id, project: r.Project}
		// Data of a file that was replaced does not count, and neither does a vector of another model.
		if r.FeatImage == r.Image {
			if model == "" || r.Model == model {
				en.vec = decodeVec(r.Vec)
			}
			en.hash, en.hasHash = parseHash(r.Phash)
		}
		ix.byID[r.Id] = len(ix.entries)
		ix.entries = append(ix.entries, en)
	}
	idxCache.Lock()
	if gen == idxGen {
		if len(idxCache.m) >= idxMaxUsers {
			idxCache.m = map[string]*userIndex{}
		}
		idxCache.m[uid] = ix
	}
	idxCache.Unlock()
	return ix, nil
}

// top returns the limit entries most similar to q, best first. keep filters, skip is left out.
func (ix *userIndex) top(q []float32, keep func(*vecEntry) bool, skip string, limit int) []hit {
	out := []hit{}
	for i := range ix.entries {
		en := &ix.entries[i]
		if en.id == skip || len(en.vec) != len(q) || (keep != nil && !keep(en)) {
			continue
		}
		var dot float32
		for j, x := range q {
			dot += x * en.vec[j]
		}
		out = append(out, hit{ID: en.id, Score: float64(dot)})
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].Score != out[b].Score {
			return out[a].Score > out[b].Score
		}
		return out[a].ID < out[b].ID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// bindSemantic drops a user's cached index when their vectors, hashes or projects change.
func bindSemantic(app core.App) {
	drop := func(e *core.RecordEvent) error {
		dropIndex(e.Record.GetString("user_id"))
		return e.Next()
	}
	app.OnRecordAfterCreateSuccess("image_features").BindFunc(drop)
	app.OnRecordAfterUpdateSuccess("image_features").BindFunc(drop)
	app.OnRecordAfterDeleteSuccess("image_features").BindFunc(drop)
	app.OnRecordAfterDeleteSuccess("inspirations").BindFunc(drop)
	app.OnRecordAfterUpdateSuccess("inspirations").BindFunc(func(e *core.RecordEvent) error {
		if e.Record.GetString("project_id") != e.Record.Original().GetString("project_id") {
			dropIndex(e.Record.GetString("user_id"))
		}
		return e.Next()
	})
}

func bindSemanticRoutes(g *router.RouterGroup[*core.RequestEvent]) {
	g.GET("/search", handleSearch)
	g.GET("/embed/status", handleEmbedStatus)
	g.GET("/duplicates", handleDuplicates)
	g.GET("/inspirations/{id}/similar", handleSimilar)
	g.GET("/inspirations/{id}/knn-suggest", handleKnnSuggest)
}

func limitParam(e *core.RequestEvent, def, max int) int {
	n, err := strconv.Atoi(e.Request.URL.Query().Get("limit"))
	if err != nil || n < 1 {
		return def
	}
	return min(n, max)
}

// ownedProject reads ?project=. ok is false (and the answer is sent) when it is not the user's.
func ownedProject(e *core.RequestEvent) (id string, ok bool, err error) {
	id = e.Request.URL.Query().Get("project")
	if id != "" && !ownsProject(e.App, e.Auth.Id, id) {
		return "", false, e.Error(http.StatusNotFound, tr(e.Request, "Το project δεν βρέθηκε.", "Project not found."), nil)
	}
	return id, true, nil
}

var errNoEmbeddings = errors.New("search by meaning is off: the user has not agreed to embeddings, or the server has no key")

// searchByMeaning embeds the text and returns the user's most similar images (project "" = all).
// project must already be checked as the user's.
func searchByMeaning(app core.App, user *core.Record, q, project string, limit int) ([]hit, error) {
	m := embedderOf(app)
	if m == nil || !user.GetBool("embed_enabled") {
		return nil, errNoEmbeddings
	}
	qv, err := m.EmbedQuery(user.Id, q)
	if err != nil {
		return nil, err
	}
	ix, err := userIdx(app, user.Id)
	if err != nil {
		return nil, err
	}
	keep := func(en *vecEntry) bool { return project == "" || en.project == project }
	return ix.top(qv, keep, "", limit), nil
}

func handleSearch(e *core.RequestEvent) error {
	q := strings.TrimSpace(e.Request.URL.Query().Get("q"))
	if q == "" || utf8.RuneCountInString(q) > 500 {
		return e.BadRequestError(tr(e.Request, "Γράψε τι ψάχνεις (έως 500 χαρακτήρες).", "Write what you look for (up to 500 characters)."), nil)
	}
	project, ok, err := ownedProject(e)
	if !ok {
		return err
	}
	hits, err := searchByMeaning(e.App, e.Auth, q, project, limitParam(e, 24, 100))
	switch {
	case errors.Is(err, errNoEmbeddings):
		return e.JSON(http.StatusOK, map[string]any{"enabled": false, "results": []hit{}})
	case errors.Is(err, errAILimit):
		return e.Error(http.StatusTooManyRequests, "daily limit reached", nil)
	case err != nil:
		e.App.Logger().Warn("search failed", "error", err.Error())
		return e.Error(http.StatusBadGateway, "model failed", nil)
	}
	return e.JSON(http.StatusOK, map[string]any{"enabled": true, "results": hits})
}

// ownedInspiration loads the inspiration of the path for the signed-in user.
func ownedInspiration(e *core.RequestEvent) (*core.Record, error) {
	r, err := e.App.FindRecordById("inspirations", e.Request.PathValue("id"))
	if err != nil || r.GetString("user_id") != e.Auth.Id {
		return nil, notFound(e)
	}
	return r, nil
}

// similarTo returns the images most like the user's image id, best first. all=false keeps to the
// image's own project. ready is false while the image has no vector.
func similarTo(app core.App, uid, id string, all bool, limit int) (ready bool, hits []hit, err error) {
	r, err := app.FindRecordById("inspirations", id)
	if err != nil || r.GetString("user_id") != uid {
		return false, nil, errNotFound
	}
	ix, err := userIdx(app, uid)
	if err != nil {
		return false, nil, err
	}
	i, found := ix.byID[id]
	if !found || ix.entries[i].vec == nil {
		return false, []hit{}, nil
	}
	project := r.GetString("project_id")
	keep := func(en *vecEntry) bool { return all || en.project == project }
	return true, ix.top(ix.entries[i].vec, keep, id, limit), nil
}

func handleSimilar(e *core.RequestEvent) error {
	ready, hits, err := similarTo(e.App, e.Auth.Id, e.Request.PathValue("id"), e.Request.URL.Query().Get("scope") == "all", limitParam(e, 12, 50))
	switch {
	case err == errNotFound:
		return notFound(e)
	case err != nil:
		return e.InternalServerError("", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"ready": ready, "results": hits})
}

// handleDuplicates lists pairs of images with almost the same picture. ?project= keeps both inside
// one project; ?id= keeps the pairs that contain that image.
func handleDuplicates(e *core.RequestEvent) error {
	project, ok, err := ownedProject(e)
	if !ok {
		return err
	}
	only := e.Request.URL.Query().Get("id")
	ix, err := userIdx(e.App, e.Auth.Id)
	if err != nil {
		return e.InternalServerError("", err)
	}
	var cand []*vecEntry
	for i := range ix.entries {
		en := &ix.entries[i]
		// A flat picture has phash "flat", so hasHash is false: it would match every other flat one.
		if en.hasHash && (project == "" || en.project == project) {
			cand = append(cand, en)
		}
	}
	type pair struct {
		A        string `json:"a"`
		B        string `json:"b"`
		Distance int    `json:"distance"`
	}
	pairs := []pair{}
	for i := range cand {
		for j := i + 1; j < len(cand); j++ {
			if only != "" && cand[i].id != only && cand[j].id != only {
				continue
			}
			if d := hamming(cand[i].hash, cand[j].hash); d <= dupMaxDistance {
				pairs = append(pairs, pair{cand[i].id, cand[j].id, d})
			}
		}
	}
	sort.Slice(pairs, func(a, b int) bool {
		if pairs[a].Distance != pairs[b].Distance {
			return pairs[a].Distance < pairs[b].Distance
		}
		return pairs[a].A+pairs[a].B < pairs[b].A+pairs[b].B
	})
	if len(pairs) > dupMaxPairs {
		pairs = pairs[:dupMaxPairs]
	}
	return e.JSON(http.StatusOK, map[string]any{"pairs": pairs})
}

// Neighbor is a labeled image near the one we suggest for.
type Neighbor struct {
	Score float64
	Level string // level id, "" for none
	Tags  []string
}

// VoteLabels turns the labels of neighbours into one level and a few tags. A neighbour counts
// e^(sharp*(score-best)): the closest ones decide and far ones barely vote. A label needs a share of
// the weight and at least two neighbours that carry it. Tags in own (already on the image) are left out.
func VoteLabels(ns []Neighbor, own []string) (level string, tags []string) {
	tags = []string{}
	if len(ns) == 0 {
		return "", tags
	}
	best := ns[0].Score
	for _, n := range ns {
		best = math.Max(best, n.Score)
	}
	var total float64
	tagW, tagN := map[string]float64{}, map[string]int{}
	lvW, lvN := map[string]float64{}, map[string]int{}
	for _, n := range ns {
		w := math.Exp(knnSharp * (n.Score - best))
		total += w
		if n.Level != "" {
			lvW[n.Level] += w
			lvN[n.Level]++
		}
		seen := map[string]bool{}
		for _, t := range n.Tags {
			if !seen[t] {
				seen[t] = true
				tagW[t] += w
				tagN[t]++
			}
		}
	}
	for l, w := range lvW {
		if lvN[l] >= knnMinVotes && w/total >= knnLevelMin && (level == "" || w > lvW[level] || (w == lvW[level] && l < level)) {
			level = l
		}
	}
	skip := map[string]bool{}
	for _, t := range own {
		skip[t] = true
	}
	for t, w := range tagW {
		if tagN[t] >= knnMinVotes && w/total >= knnTagMin && !skip[t] {
			tags = append(tags, t)
		}
	}
	sort.Slice(tags, func(a, b int) bool {
		if tagW[tags[a]] != tagW[tags[b]] {
			return tagW[tags[a]] > tagW[tags[b]]
		}
		return tags[a] < tags[b]
	})
	if len(tags) > aiMaxTags {
		tags = tags[:aiMaxTags]
	}
	return level, tags
}

// handleKnnSuggest proposes a level and tags from the labels of the user's most similar images. No
// model call: it only reads the stored vectors.
func handleKnnSuggest(e *core.RequestEvent) error {
	r, err := ownedInspiration(e)
	if r == nil {
		return err
	}
	ix, err := userIdx(e.App, e.Auth.Id)
	if err != nil {
		return e.InternalServerError("", err)
	}
	i, found := ix.byID[r.Id]
	if !found || ix.entries[i].vec == nil {
		return e.JSON(http.StatusOK, map[string]any{"ready": false, "level": nil, "tags": []string{}})
	}
	near := ix.top(ix.entries[i].vec, nil, r.Id, knnPool)
	ids := make([]string, len(near))
	for k, h := range near {
		ids[k] = h.ID
	}
	recs, err := e.App.FindRecordsByIds("inspirations", ids)
	if err != nil {
		return e.InternalServerError("", err)
	}
	byID := make(map[string]*core.Record, len(recs))
	for _, rec := range recs {
		byID[rec.Id] = rec
	}
	var ns []Neighbor
	for _, h := range near {
		rec := byID[h.ID]
		if rec == nil {
			continue
		}
		n := Neighbor{Score: h.Score, Level: rec.GetString("level"), Tags: stringList(rec.Get("tags"))}
		if n.Level == "" && len(n.Tags) == 0 {
			continue
		}
		if ns = append(ns, n); len(ns) == knnK {
			break
		}
	}
	level, tags := VoteLabels(ns, stringList(r.Get("tags")))
	return e.JSON(http.StatusOK, map[string]any{
		"ready": true, "level": nilIfEmpty(level), "level_name": nilIfEmpty(levelNames(e.App, e.Auth.Id)[level]), "tags": tags,
	})
}

func handleEmbedStatus(e *core.RequestEvent) error {
	out := map[string]any{"enabled": false, "consent": e.Auth.GetBool("embed_enabled"), "total": 0, "embedded": 0}
	m := embedderOf(e.App)
	if m == nil {
		return e.JSON(http.StatusOK, out)
	}
	uid := e.Auth.Id
	total, err := e.App.CountRecords("inspirations", dbx.HashExp{"user_id": uid})
	if err != nil {
		return e.InternalServerError("", err)
	}
	done, err := e.App.CountRecords("image_features", dbx.NewExp(
		"user_id = {:u} AND vec != '' AND model = {:m} AND dim = {:d}", dbx.Params{"u": uid, "m": m.cfg.Model, "d": m.cfg.Dim}))
	if err != nil {
		return e.InternalServerError("", err)
	}
	out["enabled"], out["total"], out["embedded"] = true, total, done
	out["model"], out["dim"] = m.cfg.Model, m.cfg.Dim
	return e.JSON(http.StatusOK, out)
}
