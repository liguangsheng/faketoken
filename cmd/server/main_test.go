package main

import "testing"

func TestInitAdminPassHasNoDefault(t *testing.T) {
	for _, pass := range []string{"", "admin123", "eleven-char"} {
		if checkInitAdminPass(pass) == nil {
			t.Fatalf("accepted %q as the first administrator's password", pass)
		}
	}
	if err := checkInitAdminPass("twelve-chars"); err != nil {
		t.Fatalf("refused a 12-character password: %v", err)
	}
	// Characters, not bytes: twelve CJK characters are twelve.
	if err := checkInitAdminPass("一二三四五六七八九十甲乙"); err != nil {
		t.Fatalf("refused twelve CJK characters: %v", err)
	}
}
