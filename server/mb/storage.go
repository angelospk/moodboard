package mb

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// Storage limit. The image bucket (Cloudflare R2) is free up to 10 GB. A new inspiration is refused
// once the stored files pass maxStoreBytes, so the free tier cannot be crossed by accident. The
// size comes from one listing of the bucket, kept for storeTTL.
const (
	storeTTL         = 10 * time.Minute
	storeListTimeout = 20 * time.Second
)

var (
	storeMu       sync.Mutex
	maxStoreBytes int64 = 8 << 30
	storeBytes    int64
	storeAt       time.Time
)

// storedBytes is the total size of the stored files, from the cache when it is fresh.
func storedBytes(app core.App) (int64, error) {
	storeMu.Lock()
	defer storeMu.Unlock()
	if !storeAt.IsZero() && time.Since(storeAt) < storeTTL {
		return storeBytes, nil
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return 0, err
	}
	defer fsys.Close()
	// A stalled bucket must not hold every upload (and this lock) for ever.
	ctx, cancel := context.WithTimeout(context.Background(), storeListTimeout)
	defer cancel()
	fsys.SetContext(ctx)
	files, err := fsys.List("")
	if err != nil {
		return 0, err
	}
	var total int64
	for _, f := range files {
		total += f.Size
	}
	storeBytes, storeAt = total, time.Now()
	return total, nil
}

// checkStoreRoom refuses a new inspiration while the store is over its limit. When the size cannot
// be read it lets the upload through: a broken listing must not block the app.
func checkStoreRoom(e *core.RecordEvent) error {
	n, err := storedBytes(e.App)
	if err != nil {
		e.App.Logger().Warn("storage size unknown", "error", err)
		return e.Next()
	}
	storeMu.Lock()
	limit := maxStoreBytes
	storeMu.Unlock()
	if n > limit {
		return apis.NewApiError(http.StatusRequestEntityTooLarge, "Ο αποθηκευτικός χώρος είναι γεμάτος. / The storage is full.", nil)
	}
	return e.Next()
}
