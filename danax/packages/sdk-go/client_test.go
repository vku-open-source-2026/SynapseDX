// Copyright 2026 danax Contributors
// Licensed under the Apache License, Version 2.0 (the "License");
package danax

import "testing"

func TestNew(t *testing.T) {
	c := New("http://localhost:8080/")
	if c.BaseURL != "http://localhost:8080" {
		t.Fatalf("trim slash: %s", c.BaseURL)
	}
}
