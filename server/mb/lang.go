package mb

import (
	"net/http"
	"strconv"
	"strings"
)

// The server writes the messages the app shows (errors, the OAuth sign-in page) in Greek or
// English. The language is the first of those two in the Accept-Language header; the web app sends
// the chosen one, a browser sends its own list. With neither, Greek.

// isEnglish reports whether the request prefers English: the supported language with the highest
// quality value wins (the first one on a tie); q=0 means not accepted.
func isEnglish(r *http.Request) bool {
	best, bestQ := false, 0.0
	for _, part := range strings.Split(r.Header.Get("Accept-Language"), ",") {
		fields := strings.Split(part, ";")
		tag := strings.ToLower(strings.TrimSpace(fields[0]))
		q := 1.0
		for _, f := range fields[1:] {
			if v, ok := strings.CutPrefix(strings.TrimSpace(f), "q="); ok {
				if n, err := strconv.ParseFloat(v, 64); err == nil {
					q = n
				}
			}
		}
		english := tag == "en" || strings.HasPrefix(tag, "en-")
		greek := tag == "el" || strings.HasPrefix(tag, "el-")
		if (english || greek) && q > bestQ {
			best, bestQ = english, q
		}
	}
	return best
}

// tr picks the Greek or the English text for the request.
func tr(r *http.Request, el, en string) string {
	if isEnglish(r) {
		return en
	}
	return el
}
