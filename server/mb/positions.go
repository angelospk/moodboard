package mb

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// dropPositions forgets where a deleted image sat on the owner's maps (node key "i:<id>", every
// scope), so no orphan map_positions rows stay behind. A failure is logged: the delete stands.
func dropPositions(e *core.RecordEvent) error {
	rs, err := e.App.FindRecordsByFilter("map_positions", "user_id = {:u} && node_key = {:k}", "", 0, 0,
		dbx.Params{"u": e.Record.GetString("user_id"), "k": "i:" + e.Record.Id})
	if err == nil {
		for _, r := range rs {
			if derr := e.App.Delete(r); derr != nil {
				err = derr
			}
		}
	}
	if err != nil {
		e.App.Logger().Warn("map positions of a deleted image not removed", "id", e.Record.Id, "error", err)
	}
	return e.Next()
}
