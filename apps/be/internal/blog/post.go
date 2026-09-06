// Package blog is the domain: what a post is, what makes one valid, and how Markdown becomes
// the HTML a reader sees. It knows nothing about HTTP or SQLite.
package blog

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Post is a published article as the store holds it: the Markdown a writer gave and the HTML
// rendered from it once, on write, so a read never renders.
type Post struct {
	Slug           string
	Title          string
	Summary        string
	Author         string
	Cover          string
	Tags           []string
	Markdown       string
	HTML           string
	ReadingMinutes int
	PublishedAt    time.Time
	UpdatedAt      time.Time
}

// Draft is what a writer submits. Everything derived (HTML, reading time, timestamps) is the
// service's to compute.
type Draft struct {
	Title       string
	Summary     string
	Author      string
	Cover       string
	Tags        []string
	Markdown    string
	PublishedAt *time.Time
}

// ErrNotFound is returned for a slug the store does not hold.
var ErrNotFound = errors.New("post not found")

// ValidationError names the field a draft failed on, so an API can report it precisely.
type ValidationError struct {
	Field string
	Msg   string
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Msg }

var slugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

const (
	maxSlug     = 120
	maxTitle    = 200
	maxSummary  = 500
	maxAuthor   = 80
	maxCover    = 2048
	maxTags     = 10
	maxMarkdown = 256 * 1024
)

// ValidateSlug accepts lowercase words joined by single hyphens, up to 120 characters.
func ValidateSlug(slug string) error {
	if slug == "" || len(slug) > maxSlug || !slugPattern.MatchString(slug) {
		return &ValidationError{Field: "slug", Msg: "lowercase letters, digits and single hyphens, 1 to 120 characters"}
	}
	return nil
}

// Validate checks a draft's fields. Limits are generous for prose and strict for identifiers.
func (d Draft) Validate() error {
	if n := utf8.RuneCountInString(strings.TrimSpace(d.Title)); n == 0 || n > maxTitle {
		return &ValidationError{Field: "title", Msg: fmt.Sprintf("1 to %d characters", maxTitle)}
	}
	if utf8.RuneCountInString(d.Summary) > maxSummary {
		return &ValidationError{Field: "summary", Msg: fmt.Sprintf("at most %d characters", maxSummary)}
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(d.Author)); n == 0 || n > maxAuthor {
		return &ValidationError{Field: "author", Msg: fmt.Sprintf("1 to %d characters", maxAuthor)}
	}
	if d.Cover != "" && (len(d.Cover) > maxCover || !(strings.HasPrefix(d.Cover, "https://") || strings.HasPrefix(d.Cover, "http://") || strings.HasPrefix(d.Cover, "/"))) {
		return &ValidationError{Field: "cover", Msg: "an http(s) URL or a site-relative path"}
	}
	if len(d.Tags) > maxTags {
		return &ValidationError{Field: "tags", Msg: fmt.Sprintf("at most %d", maxTags)}
	}
	for _, t := range d.Tags {
		if err := ValidateSlug(t); err != nil {
			return &ValidationError{Field: "tags", Msg: "each tag is slug-shaped"}
		}
	}
	if strings.TrimSpace(d.Markdown) == "" || len(d.Markdown) > maxMarkdown {
		return &ValidationError{Field: "markdown", Msg: fmt.Sprintf("1 byte to %d KiB", maxMarkdown/1024)}
	}
	return nil
}
