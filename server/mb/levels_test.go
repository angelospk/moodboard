package mb_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"

	"moodboard/server/migrations"
)

// levelID returns the id of the user's level with that name.
func (e *env) levelID(uid, name string) string {
	e.t.Helper()
	r, err := e.app.FindFirstRecordByFilter("levels", "user_id = {:u} && name = {:n}", dbx.Params{"u": uid, "n": name})
	if err != nil {
		e.t.Fatalf("level %q of %s: %v", name, uid, err)
	}
	return r.Id
}

func TestNewUserGetsDefaultLevels(t *testing.T) {
	e := newEnv(t)
	alice, _ := e.user("alice@x.gr")
	rs, err := e.app.FindRecordsByFilter("levels", "user_id = {:u}", "position", 0, 0, dbx.Params{"u": alice.Id})
	if err != nil || len(rs) != len(migrations.DefaultLevels) {
		t.Fatalf("want %d seeded levels, got %d (%v)", len(migrations.DefaultLevels), len(rs), err)
	}
	for i, r := range rs {
		if r.GetString("name") != migrations.DefaultLevels[i] || r.GetInt("position") != i {
			t.Fatalf("level %d: %q pos %d", i, r.GetString("name"), r.GetInt("position"))
		}
	}
}

func TestLevelsAPI(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	bob, bTok := e.user("bob@x.gr")
	api := "/api/collections/levels/records"

	// Alice adds any level she wants; names are unique per user, ignoring case.
	code, out := e.json("POST", api, aTok, map[string]any{"user_id": alice.Id, "name": "Κήπος", "position": 5})
	if code != 200 {
		t.Fatalf("create level: %d %s", code, out)
	}
	var made struct{ Id string }
	_ = json.Unmarshal([]byte(out), &made)
	if code, _ = e.json("POST", api, aTok, map[string]any{"user_id": alice.Id, "name": "κήπος", "position": 6}); code != 400 {
		t.Fatalf("duplicate name: want 400, got %d", code)
	}
	// Bob may reuse the name, but cannot see, change or delete Alice's levels, nor create one for her.
	if code, _ = e.json("POST", api, bTok, map[string]any{"user_id": bob.Id, "name": "Κήπος", "position": 5}); code != 200 {
		t.Fatalf("bob same name: %d", code)
	}
	if code, _ = e.json("POST", api, bTok, map[string]any{"user_id": alice.Id, "name": "Κρυφό", "position": 9}); code == 200 {
		t.Fatalf("bob created a level for alice")
	}
	if code, out = e.req("GET", api, bTok, nil, ""); code != 200 || strings.Contains(out, made.Id) {
		t.Fatalf("bob lists alice's level: %d %s", code, out)
	}
	if code, _ = e.json("PATCH", api+"/"+made.Id, bTok, map[string]any{"name": "x"}); code != 404 {
		t.Fatalf("bob patches alice's level: %d", code)
	}
	if code, _ = e.req("DELETE", api+"/"+made.Id, bTok, nil, ""); code != 404 {
		t.Fatalf("bob deletes alice's level: %d", code)
	}
	// A name cannot be empty or very long.
	if code, _ = e.json("POST", api, aTok, map[string]any{"user_id": alice.Id, "name": "", "position": 7}); code != 400 {
		t.Fatalf("empty name: %d", code)
	}
	if code, _ = e.json("POST", api, aTok, map[string]any{"user_id": alice.Id, "name": strings.Repeat("α", 41), "position": 7}); code != 400 {
		t.Fatalf("long name: %d", code)
	}
}

func TestLevelsLimit(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	api := "/api/collections/levels/records"
	for i := len(migrations.DefaultLevels); i < 50; i++ {
		e.record("levels", map[string]any{"user_id": alice.Id, "name": "L" + string(rune('a'+i%26)) + string(rune('a'+i/26)), "position": i})
	}
	if code, out := e.json("POST", api, aTok, map[string]any{"user_id": alice.Id, "name": "Πολλά", "position": 50}); code != 400 {
		t.Fatalf("51st level: want 400, got %d %s", code, out)
	}
}

func TestInspirationLevelIsOwnedAndNulledOnDelete(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	bob, bTok := e.user("bob@x.gr")
	mine := e.levelID(alice.Id, "Υλικό")
	bobs := e.levelID(bob.Id, "Υλικό")

	code, out := e.upload(aTok, map[string]string{"user_id": alice.Id, "level": mine})
	if code != 200 {
		t.Fatalf("upload with own level: %d %s", code, out)
	}
	var a struct{ Id, Level string }
	_ = json.Unmarshal([]byte(out), &a)
	if a.Level != mine {
		t.Fatalf("level not stored: %s", out)
	}
	if code, _ = e.upload(aTok, map[string]string{"user_id": alice.Id, "level": bobs}); code != 400 {
		t.Fatalf("another user's level on create: want 400, got %d", code)
	}
	if code, _ = e.json("PATCH", "/api/collections/inspirations/records/"+a.Id, aTok, map[string]any{"level": bobs}); code != 400 {
		t.Fatalf("another user's level on update: want 400, got %d", code)
	}
	if code, _ = e.upload(bTok, map[string]string{"user_id": bob.Id, "level": mine}); code != 400 {
		t.Fatalf("bob using alice's level: want 400, got %d", code)
	}
	// Removing a level keeps the image and clears its level.
	if code, out = e.req("DELETE", "/api/collections/levels/records/"+mine, aTok, nil, ""); code != 204 {
		t.Fatalf("delete level: %d %s", code, out)
	}
	r, err := e.app.FindRecordById("inspirations", a.Id)
	if err != nil || r.GetString("level") != "" {
		t.Fatalf("level after delete: %v %q", err, r.GetString("level"))
	}
}

func TestMCPLevels(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice@x.gr")
	bob, bTok := e.user("bob@x.gr")
	e.record("levels", map[string]any{"user_id": alice.Id, "name": "Κήπος", "position": 5})
	e.record("levels", map[string]any{"user_id": bob.Id, "name": "Μυστικό επίπεδο", "position": 5})
	call := func(tok, name string, args map[string]any) string {
		_, out := mcpCall(e, tok, "tools/call", map[string]any{"name": name, "arguments": args})
		return out
	}
	if code, out := mcpCall(e, aTok, "tools/list", map[string]any{}); code != 200 || !strings.Contains(out, "list_levels") {
		t.Fatalf("tools/list: %d %s", code, out)
	}
	out := call(aTok, "list_levels", map[string]any{})
	mustHave(t, out, "Κήπος", "Αστικό", "Υλικό")
	mustLack(t, out, "Μυστικό επίπεδο")

	garden := e.levelID(alice.Id, "Κήπος")
	_, up := e.upload(aTok, map[string]string{"user_id": alice.Id, "note": "στη βεράντα", "level": garden})
	var a struct{ Id string }
	_ = json.Unmarshal([]byte(up), &a)
	_, up = e.upload(aTok, map[string]string{"user_id": alice.Id, "note": "άλλο"})
	var other struct{ Id string }
	_ = json.Unmarshal([]byte(up), &other)

	// Search by level name, any case; rows show the name, not the id.
	out = call(aTok, "search_inspirations", map[string]any{"level": "κήπος"})
	mustHave(t, out, a.Id, `\"level\": \"Κήπος\"`)
	mustLack(t, out, other.Id, garden)
	if out = call(aTok, "search_inspirations", map[string]any{"level": "Μυστικό επίπεδο"}); !strings.Contains(out, `"isError":true`) || !strings.Contains(out, "list_levels") {
		t.Fatalf("unknown level in search: %s", out)
	}
	// A rename shows at once, with no change to the rows.
	r, _ := e.app.FindRecordById("levels", garden)
	r.Set("name", "Βεράντα")
	if err := e.app.Save(r); err != nil {
		t.Fatal(err)
	}
	out = call(aTok, "search_inspirations", map[string]any{"level": "Βεράντα"})
	mustHave(t, out, a.Id, `\"level\": \"Βεράντα\"`)

	// suggest_labels takes a name and stores the level id; it must be the user's own.
	if out = call(aTok, "suggest_labels", map[string]any{"id": other.Id, "level": "huge"}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("unknown level accepted: %s", out)
	}
	if out = call(aTok, "suggest_labels", map[string]any{"id": other.Id, "level": "Μυστικό επίπεδο"}); !strings.Contains(out, `"isError":true`) {
		t.Fatalf("bob's level accepted: %s", out)
	}
	if out = call(aTok, "suggest_labels", map[string]any{"id": other.Id, "level": "βεράντα", "tags": []string{"φως"}}); strings.Contains(out, `"isError":true`) {
		t.Fatalf("suggest_labels: %s", out)
	}
	mustHave(t, out, `\"level\": \"Βεράντα\"`)
	row, _ := e.app.FindRecordById("inspirations", other.Id)
	var s struct {
		Level string `json:"level"`
	}
	if err := row.UnmarshalJSONField("suggestion", &s); err != nil || s.Level != garden {
		t.Fatalf("stored suggestion level: %+v %v", s, err)
	}
	if row.GetString("level") != "" {
		t.Fatalf("suggestion changed the level")
	}
	_ = bTok
}
