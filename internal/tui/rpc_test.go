package tui

import (
	"testing"
	"time"
)

func TestRPCTimeout(t *testing.T) {
	if got := rpcTimeout("chatTurn"); got != 8*time.Minute {
		t.Fatalf("chatTurn timeout = %v, want %v", got, 8*time.Minute)
	}

	if got := rpcTimeout("openSession"); got != 20*time.Second {
		t.Fatalf("openSession timeout = %v, want %v", got, 20*time.Second)
	}

	if got := rpcTimeout("shutdownManagedOllama"); got != 20*time.Second {
		t.Fatalf("shutdownManagedOllama timeout = %v, want %v", got, 20*time.Second)
	}

	if got := rpcTimeout("getBoard"); got != 10*time.Second {
		t.Fatalf("default timeout = %v, want %v", got, 10*time.Second)
	}
}
