package mb

// CleanupOAuth exposes the hourly cleanup to the tests.
var CleanupOAuth = cleanupOAuth

// WaitThumbs waits for the background thumbnails of uploads.
var WaitThumbs = thumbJobs.Wait

// HoldThumbSlot takes the shared thumbnail slot until the returned func is called.
func HoldThumbSlot() func() {
	thumbSlot <- struct{}{}
	return func() { <-thumbSlot }
}
