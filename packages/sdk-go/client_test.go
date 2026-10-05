package olp

import "testing"

func TestNew(t *testing.T) {
	c := New("http://localhost:8080/")
	if c.BaseURL != "http://localhost:8080" {
		t.Fatalf("trim slash: %s", c.BaseURL)
	}
}
