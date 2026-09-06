package blog

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
)

// One parser for the process: goldmark's Markdown is safe to share across goroutines.
var markdown = goldmark.New(
	goldmark.WithExtensions(extension.GFM, extension.Typographer),
	goldmark.WithParserOptions(parser.WithAutoHeadingID()),
)

// Render turns Markdown into HTML. Raw HTML in the source is dropped, which is goldmark's
// default and the reason a post body cannot carry a script.
func Render(src string) (string, error) {
	var out bytes.Buffer
	if err := markdown.Convert([]byte(src), &out); err != nil {
		return "", fmt.Errorf("render markdown: %w", err)
	}
	return out.String(), nil
}

// wordsPerMinute is the figure most readers use; the reference article reports "7 min" for
// about 1,600 words, which this reproduces.
const wordsPerMinute = 238

// ReadingMinutes estimates how long a post takes to read, never below one minute.
func ReadingMinutes(src string) int {
	words := len(strings.Fields(src))
	minutes := (words + wordsPerMinute - 1) / wordsPerMinute
	if minutes < 1 {
		return 1
	}
	return minutes
}
