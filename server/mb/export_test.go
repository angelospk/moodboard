package mb

import "time"

// CleanupOAuth exposes the hourly cleanup to the tests.
var CleanupOAuth = cleanupOAuth

// WaitThumbs waits for the background thumbnails of uploads.
var WaitThumbs = thumbJobs.Wait

// HoldThumbSlot takes the shared thumbnail slot until the returned func is called.
func HoldThumbSlot() func() {
	thumbSlot <- struct{}{}
	return func() { <-thumbSlot }
}

// SetStoreLimit sets the storage limit in bytes and forgets the cached size.
func SetStoreLimit(n int64) {
	storeMu.Lock()
	defer storeMu.Unlock()
	maxStoreBytes = n
	storeAt = time.Time{}
}
