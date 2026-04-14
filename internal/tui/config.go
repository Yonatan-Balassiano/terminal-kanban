package tui

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

func DefaultSocketPath() string {
	if value := os.Getenv("AGENTBOARD_SOCKET_PATH"); value != "" {
		return value
	}

	tmpDir := os.TempDir()
	uid := "user"
	if runtime.GOOS != "windows" {
		uid = strconv.Itoa(os.Getuid())
	}

	return filepath.Join(tmpDir, "agentboard-"+uid+".sock")
}
