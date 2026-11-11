package mb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"

	"moodboard/server/migrations"
)

const inlineImageBytes = 2 << 20

type ctxKey struct{}

// bindMCP serves a stateless MCP endpoint at /mcp. Auth: "Authorization: Bearer <users auth token>"
// (a long-lived one comes from `moodboard mcp-token <email>`). Every tool runs as that user.
func bindMCP(se *core.ServeEvent) {
	h := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		user, _ := r.Context().Value(ctxKey{}).(*core.Record)
		return NewMCPServer(se.App, user)
	}, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true,
		// The server listens on loopback behind cloudflared, so every request looks local; the SDK's
		// localhost (DNS rebinding) check would reject the public Host. /mcp needs a bearer token anyway.
		DisableLocalhostProtection: true,
	})

	se.Router.Any("/mcp", func(e *core.RequestEvent) error {
		ctx := context.WithValue(e.Request.Context(), ctxKey{}, e.Auth)
		h.ServeHTTP(e.Response, e.Request.WithContext(ctx))
		return nil
	}).BindFunc(mcpChallenge)
}

func jsonResult(v any) (*mcp.CallToolResult, any, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, nil, nil
}

type (
	noArgs     struct{}
	searchArgs struct {
		Query     string   `json:"query,omitempty" jsonschema:"Words to find in the note or source title"`
		Project   string   `json:"project,omitempty" jsonschema:"Project name or id"`
		Tags      []string `json:"tags,omitempty" jsonschema:"All of these tags must be present"`
		Level     string   `json:"level,omitempty" jsonschema:"Scale: urban, building, interior, detail or material"`
		Limit     int      `json:"limit,omitempty" jsonschema:"1..100, default 20"`
		Unlabeled bool     `json:"unlabeled,omitempty" jsonschema:"Only inspirations with no level or no tags and no pending suggestion"`
	}
	idArgs struct {
		ID string `json:"id" jsonschema:"Inspiration id"`
	}
	saveArgs struct {
		ImageURL    string   `json:"image_url" jsonschema:"Public https image URL"`
		Project     string   `json:"project,omitempty" jsonschema:"Project name or id (created if missing)"`
		Note        string   `json:"note,omitempty"`
		Tags        []string `json:"tags,omitempty"`
		Level       string   `json:"level,omitempty" jsonschema:"urban, building, interior, detail or material"`
		SourceURL   string   `json:"source_url,omitempty"`
		SourceTitle string   `json:"source_title,omitempty"`
	}
	suggestArgs struct {
		ID    string   `json:"id" jsonschema:"Inspiration id"`
		Level string   `json:"level,omitempty" jsonschema:"urban, building, interior, detail or material"`
		Tags  []string `json:"tags,omitempty" jsonschema:"Short lowercase tags in the user's language, at most 10"`
	}
	noteArgs struct {
		ID   string `json:"id" jsonschema:"Inspiration id"`
		Text string `json:"text" jsonschema:"Text to append (max 5000 chars)"`
	}
)

func ptr[T any](v T) *T { return &v }

// NewMCPServer builds the tool set bound to one user. user must not be nil.
func NewMCPServer(app core.App, user *core.Record) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "moodboard", Version: "0.2.0"}, nil)
	ro := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: ptr(false)}
	uid := user.Id

	mcp.AddTool(s, &mcp.Tool{Name: "list_projects", Title: "List projects", Annotations: ro,
		Description: "List the user's moodboard projects with how many inspirations each has."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ noArgs) (*mcp.CallToolResult, any, error) {
			return jsonResult(listProjects(app, uid))
		})

	mcp.AddTool(s, &mcp.Tool{Name: "search_inspirations", Title: "Search inspirations", Annotations: ro,
		Description: "Search saved inspirations (images with notes, tags, level and marked details). Newest first. Use get_inspiration to see one image."},
		func(ctx context.Context, _ *mcp.CallToolRequest, a searchArgs) (*mcp.CallToolResult, any, error) {
			rows, err := searchInspirations(app, uid, a)
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(rows)
		})

	mcp.AddTool(s, &mcp.Tool{Name: "get_inspiration", Title: "Get inspiration", Annotations: ro,
		Description: "Get one inspiration with its image, note and marked regions. Regions are rectangles in fractions (0..1) of the image with the user's note on what they like there."},
		func(ctx context.Context, _ *mcp.CallToolRequest, a idArgs) (*mcp.CallToolResult, any, error) {
			return getInspiration(app, user, a.ID)
		})

	mcp.AddTool(s, &mcp.Tool{Name: "save_inspiration", Title: "Save inspiration",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(true)},
		Description: "Save a public https image to the moodboard, optionally in a project (created if missing) with a note, tags and level."},
		func(ctx context.Context, _ *mcp.CallToolRequest, a saveArgs) (*mcp.CallToolResult, any, error) {
			r, err := saveInspiration(ctx, app, uid, a, FetchImage)
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(publicRow(r, ""))
		})

	mcp.AddTool(s, &mcp.Tool{Name: "suggest_labels", Title: "Suggest level and tags",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(false), IdempotentHint: true, OpenWorldHint: ptr(false)},
		Description: "Propose a level and tags for an inspiration after looking at its image (get_inspiration). " +
			"They are stored as a suggestion the user accepts or dismisses in the web app; the current level and tags do not change. " +
			"A new suggestion replaces an older one. Find work with search_inspirations {unlabeled: true}. " +
			"Reuse the user's existing tags where they fit."},
		func(ctx context.Context, _ *mcp.CallToolRequest, a suggestArgs) (*mcp.CallToolResult, any, error) {
			r, err := suggestLabels(app, uid, a)
			if err != nil {
				return nil, nil, err
			}
			return jsonResult(publicRow(r, ""))
		})

	mcp.AddTool(s, &mcp.Tool{Name: "add_note", Title: "Add note",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(false)},
		Description: "Append a thought to an inspiration's note. Existing text is kept."},
		func(ctx context.Context, _ *mcp.CallToolRequest, a noteArgs) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(a.Text) == "" || utf8.RuneCountInString(a.Text) > 5000 {
				return nil, nil, errors.New("text must be 1..5000 characters")
			}
			r, err := AppendNote(app, uid, a.ID, a.Text)
			if err != nil {
				return nil, nil, fmt.Errorf("inspiration not found: %s", a.ID)
			}
			return jsonResult(map[string]string{"id": r.Id, "note": r.GetString("note")})
		})
	return s
}

func publicRow(r *core.Record, project string) map[string]any {
	row := map[string]any{
		"id": r.Id, "project_id": nilIfEmpty(r.GetString("project_id")), "note": r.GetString("note"),
		"tags": stringList(r.Get("tags")), "level": nilIfEmpty(r.GetString("level")), "regions": r.Get("regions"),
		"source_url": nilIfEmpty(r.GetString("source_url")), "source_title": nilIfEmpty(r.GetString("source_title")),
		"created_at": r.GetString("created_at"),
	}
	if sg := r.Get("suggestion"); hasSuggestion(r) {
		row["suggestion"] = sg
	}
	if project != "" {
		row["project"] = project
	}
	return row
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func listProjects(app core.App, uid string) []map[string]any {
	var rows []struct {
		Id          string `db:"id" json:"id"`
		Name        string `db:"name" json:"name"`
		Description string `db:"description" json:"description"`
		CreatedAt   string `db:"created_at" json:"created_at"`
		Count       int    `db:"n" json:"inspiration_count"`
	}
	_ = app.DB().NewQuery(`SELECT p.id, p.name, p.description, p.created_at,
		(SELECT count(*) FROM inspirations i WHERE i.project_id = p.id) AS n
		FROM projects p WHERE p.user_id = {:u} ORDER BY p.created_at DESC`).Bind(dbx.Params{"u": uid}).All(&rows)
	out := make([]map[string]any, len(rows))
	for i, r := range rows {
		out[i] = map[string]any{"id": r.Id, "name": r.Name, "description": r.Description, "created_at": r.CreatedAt, "inspiration_count": r.Count}
	}
	return out
}

// resolveProject finds a project by id or case-insensitive name; with create it makes a missing one.
func resolveProject(app core.App, uid, ref string, create bool) (*core.Record, error) {
	ref = strings.TrimSpace(ref)
	if r, err := app.FindRecordById("projects", ref); err == nil && r.GetString("user_id") == uid {
		return r, nil
	}
	rs, err := app.FindRecordsByFilter("projects", "user_id = {:u} && name ~ {:n}", "", 0, 0, dbx.Params{"u": uid, "n": ref})
	if err == nil {
		for _, r := range rs {
			if strings.EqualFold(r.GetString("name"), ref) {
				return r, nil
			}
		}
	}
	if !create || ref == "" {
		return nil, fmt.Errorf("project not found: %s", ref)
	}
	coll, err := app.FindCollectionByNameOrId("projects")
	if err != nil {
		return nil, err
	}
	p := core.NewRecord(coll)
	p.Set("user_id", uid)
	p.Set("name", ref)
	return p, app.Save(p)
}

var nonText = regexp.MustCompile(`[^\p{L}\p{N}\s'-]`)

func searchInspirations(app core.App, uid string, a searchArgs) ([]map[string]any, error) {
	limit := a.Limit
	if limit <= 0 {
		limit = 20
	}
	limit = min(limit, 100)
	filter := []string{"user_id = {:u}"}
	params := dbx.Params{"u": uid}
	if a.Project != "" {
		p, err := resolveProject(app, uid, a.Project, false)
		if err != nil {
			return nil, err
		}
		filter = append(filter, "project_id = {:p}")
		params["p"] = p.Id
	}
	if a.Level != "" {
		if !slices.Contains(migrations.Levels, a.Level) {
			return nil, fmt.Errorf("invalid level: %s", a.Level)
		}
		filter = append(filter, "level = {:l}")
		params["l"] = a.Level
	}
	if text := strings.TrimSpace(nonText.ReplaceAllString(a.Query, " ")); text != "" {
		filter = append(filter, "(note ~ {:q} || source_title ~ {:q})")
		params["q"] = text
	}
	want := CleanTags(a.Tags)
	// Tag containment is checked in Go: the JSON array has no exact-match filter operator.
	rs, err := app.FindRecordsByFilter("inspirations", strings.Join(filter, " && "), "-created_at", 0, 0, params)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	out := []map[string]any{}
	for _, r := range rs {
		have := stringList(r.Get("tags"))
		if !containsAll(have, want) || a.Unlabeled && (hasSuggestion(r) || r.GetString("level") != "" && len(have) > 0) {
			continue
		}
		pid := r.GetString("project_id")
		if pid != "" && names[pid] == "" {
			if p, err := app.FindRecordById("projects", pid); err == nil {
				names[pid] = p.GetString("name")
			}
		}
		out = append(out, publicRow(r, names[pid]))
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func containsAll(have, want []string) bool {
	for _, w := range want {
		if !slices.Contains(have, w) {
			return false
		}
	}
	return true
}

func getInspiration(app core.App, user *core.Record, id string) (*mcp.CallToolResult, any, error) {
	r, err := app.FindRecordById("inspirations", id)
	if err != nil || r.GetString("user_id") != user.Id {
		return nil, nil, fmt.Errorf("inspiration not found: %s", id)
	}
	project := ""
	if p, err := app.FindRecordById("projects", r.GetString("project_id")); err == nil {
		project = p.GetString("name")
	}
	row := publicRow(r, project)
	key := r.BaseFilesPath() + "/" + r.GetString("image")
	if tok, err := user.NewFileToken(); err == nil {
		row["image_url"] = strings.TrimRight(app.Settings().Meta.AppURL, "/") + "/api/files/" + key + "?token=" + tok
	}
	b, _ := json.MarshalIndent(row, "", "  ")
	content := []mcp.Content{&mcp.TextContent{Text: string(b)}}
	if fsys, err := app.NewFilesystem(); err == nil {
		defer fsys.Close()
		if rd, err := fsys.GetReader(key); err == nil {
			defer rd.Close()
			if rd.Size() <= inlineImageBytes {
				if data, err := io.ReadAll(rd); err == nil {
					content = append(content, &mcp.ImageContent{Data: data, MIMEType: rd.ContentType()})
				}
			}
		}
	}
	return &mcp.CallToolResult{Content: content}, nil, nil
}

type imageFetcher func(ctx context.Context, url string) ([]byte, string, error)

func saveInspiration(ctx context.Context, app core.App, uid string, a saveArgs, fetch imageFetcher) (*core.Record, error) {
	if a.Level != "" && !slices.Contains(migrations.Levels, a.Level) {
		return nil, fmt.Errorf("invalid level: %s", a.Level)
	}
	if utf8.RuneCountInString(a.Note) > 5000 || utf8.RuneCountInString(a.SourceTitle) > 300 || len(a.Tags) > 30 {
		return nil, errors.New("note, source_title or tags too long")
	}
	if a.SourceURL != "" && !strings.HasPrefix(a.SourceURL, "http://") && !strings.HasPrefix(a.SourceURL, "https://") {
		return nil, errors.New("source_url must be an http(s) URL")
	}
	// Fetch first: a failed download must not leave a newly created, empty project behind.
	data, typ, err := fetch(ctx, a.ImageURL)
	if err != nil {
		return nil, err
	}
	var project *core.Record
	if a.Project != "" {
		p, err := resolveProject(app, uid, a.Project, true)
		if err != nil {
			return nil, err
		}
		project = p
	}
	f, err := filesystem.NewFileFromBytes(data, "image."+imageExt[typ])
	if err != nil {
		return nil, err
	}
	coll, err := app.FindCollectionByNameOrId("inspirations")
	if err != nil {
		return nil, err
	}
	r := core.NewRecord(coll)
	r.Set("user_id", uid)
	if project != nil {
		r.Set("project_id", project.Id)
	}
	src := a.SourceURL
	if src == "" {
		src = a.ImageURL
	}
	r.Set("image", f)
	r.Set("note", strings.TrimSpace(a.Note))
	r.Set("tags", CleanTags(a.Tags))
	r.Set("level", a.Level)
	r.Set("regions", []any{})
	r.Set("source_url", src)
	r.Set("source_title", a.SourceTitle)
	return r, app.Save(r)
}

// hasSuggestion reports a pending suggestion (the field is null or {} when there is none).
func hasSuggestion(r *core.Record) bool {
	var s struct {
		Level string   `json:"level"`
		Tags  []string `json:"tags"`
	}
	return r.UnmarshalJSONField("suggestion", &s) == nil && (s.Level != "" || len(s.Tags) > 0)
}

func suggestLabels(app core.App, uid string, a suggestArgs) (*core.Record, error) {
	if a.Level != "" && !slices.Contains(migrations.Levels, a.Level) {
		return nil, fmt.Errorf("invalid level: %s", a.Level)
	}
	tags := CleanTags(a.Tags)
	if len(tags) > 10 {
		tags = tags[:10]
	}
	if a.Level == "" && len(tags) == 0 {
		return nil, errors.New("give a level or at least one tag")
	}
	r, err := app.FindRecordById("inspirations", a.ID)
	if err != nil || r.GetString("user_id") != uid {
		return nil, fmt.Errorf("inspiration not found: %s", a.ID)
	}
	r.Set("suggestion", map[string]any{"level": nilIfEmpty(a.Level), "tags": tags})
	return r, app.Save(r)
}
