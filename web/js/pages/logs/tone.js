/** The colours a log row reads in. */

const statusTone = (code) => {
  if (code < 400) return 'success'
  if (code < 500) return 'warning'
  return 'danger'
}

// An upstream can answer 200 and then fail inside the body — an SSE stream
// that ends with an error event is the common case. The status code we
// relayed is still the truth, so it is shown unchanged; only the colour
// follows the error field, because a green 200 on a failed call is what
// hides these rows entirely.
export const rowTone = (row) => (row.error && row.status_code < 400 ? 'warning' : statusTone(row.status_code))

// Only the named levels get a colour; a token budget stays neutral because
// "16k tokens" carries no ordering against "high".
export const REASONING_TONE = {
  minimal: null,
  low: 'brand',
  medium: 'warning',
  high: 'danger',
}

/** Share of the input that came from cache. Zero input means zero rate. */
export const cacheRate = (entry) => (entry.prompt_tokens > 0 ? entry.cached_tokens / entry.prompt_tokens : 0)
