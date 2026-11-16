package mb_test

import (
	"encoding/json"
	"testing"

	"moodboard/server/mb"
)

// QA 2026-11-15 F11: deleting an image left its map_positions rows behind.
func TestDeleteImageDropsItsPositions(t *testing.T) {
	e := newEnv(t)
	alice, aTok := e.user("alice-pos@test.local")
	bob, _ := e.user("bob-pos@test.local")
	code, out := e.upload(aTok, map[string]string{"user_id": alice.Id})
	if code != 200 {
		t.Fatalf("upload: %d %s", code, out)
	}
	var made struct{ Id string }
	_ = json.Unmarshal([]byte(out), &made)
	ins, err := e.app.FindRecordById("inspirations", made.Id)
	if err != nil {
		t.Fatal(err)
	}
	key := "i:" + ins.Id
	e.record("map_positions", map[string]any{"user_id": alice.Id, "scope": "all", "node_key": key, "x": 1, "y": 2})
	e.record("map_positions", map[string]any{"user_id": alice.Id, "scope": "none", "node_key": key, "x": 3, "y": 4})
	e.record("map_positions", map[string]any{"user_id": alice.Id, "scope": "all", "node_key": "t:wood", "x": 5, "y": 6})
	e.record("map_positions", map[string]any{"user_id": bob.Id, "scope": "all", "node_key": key, "x": 7, "y": 8})
	if err := e.app.Delete(ins); err != nil {
		t.Fatal(err)
	}
	left, _ := e.app.FindRecordsByFilter("map_positions", "node_key = {:k} && user_id = {:u}", "", 0, 0, map[string]any{"k": key, "u": alice.Id})
	if len(left) != 0 {
		t.Fatalf("want the image's positions gone, %d left", len(left))
	}
	all, _ := e.app.FindAllRecords("map_positions")
	if len(all) != 2 {
		t.Fatalf("want the tag's and the other user's rows kept (2), got %d", len(all))
	}
}

// QA 2026-11-15 F12: «warm  light» (two spaces) and «warm light» are one tag.
func TestCleanTagsCollapsesInnerSpace(t *testing.T) {
	got := mb.CleanTags([]string{"Warm  light", "warm light", " x\ty "})
	if len(got) != 2 || got[0] != "warm light" || got[1] != "x y" {
		t.Fatalf("got %q", got)
	}
}
